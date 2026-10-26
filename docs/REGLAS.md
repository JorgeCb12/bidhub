# Reglas de negocio de BidHub

Convención de capas:

- **BD** = constraint o FK que la base de datos impone.
- **Backend** = validación en el route handler o service, dentro de una transacción si toca escritura.
- **Frontend** = validación UX opcional; nunca es la única garantía.

Las reglas se garantizan en **backend + BD**. El frontend solo refleja.

---

## Publicación

### 1. Precio inicial > 0, incremento mínimo > 0, fecha de cierre definida.

- **BD:** `CHECK (startingPrice > 0)`, `CHECK (minIncrement > 0)`, `endsAt NOT NULL` en `Auction`.
- **Backend:** Zod en `POST /api/auctions`: `startingPrice > 0`, `minIncrement > 0`, `endsAt` requerido.

### 2. Fecha de cierre entre 1 hora y 7 días desde la publicación.

- **Backend:** Zod `refine` sobre `endsAt`: `endsAt >= now + 1h && endsAt <= now + 7d`. Comparación hecha en el handler, no en el schema estático (depende de `now`).

### 3. Cada subasta pertenece a una categoría existente.

- **BD:** FK `Auction.categoryId → Category.id`, `onDelete: Restrict`.
- **Backend:** si la categoría no existe, `404 CATEGORY_NOT_FOUND` antes de crear.

### 4. Máximo 5 subastas activas por vendedor.

- **Backend:** dentro de la transacción de `POST /api/auctions`:
  `COUNT(Auction WHERE sellerId = session.user.id AND status = ACTIVE)`.
  Si `>= 5` → `409 AUCTION_LIMIT_REACHED`.
- **Nota:** "activas" incluye las que ya vencieron pero aún no se han resuelto; el conteo debe ejecutarse **después** de `resolveAuctionStatus` sobre las del vendedor, o filtrar por `status = ACTIVE AND endsAt > now()`. Se opta por `status = ACTIVE AND endsAt > now()` para no depender del orden.

### 5. El vendedor edita solo si no tiene ofertas y está activa.

- **Backend:** en `PATCH /api/auctions/[id]`:
  - `auction.sellerId === session.user.id` (si no, `403`).
  - `auction.status === ACTIVE && auction.endsAt > now()` (si no, `409 AUCTION_NOT_EDITABLE`).
  - `COUNT(Bid WHERE auctionId = id) === 0` (si no, `409 AUCTION_HAS_BIDS`).
- Todo dentro de transacción con `SELECT ... FOR UPDATE` sobre la subasta (o `prisma.$transaction` con aislamiento suficiente).

---

## Ofertas

### 6. Un usuario no puede ofertar en su propia subasta.

- **Backend:** en `POST /api/bids`: `auction.sellerId !== session.user.id`, si no → `403 OWN_AUCTION_BID`.

### 7. Solo se oferta en subasta activa (no cancelada, `endsAt` no llegó).

- **Backend:** en `POST /api/bids`: `auction.status === ACTIVE && auction.endsAt > now()`, si no → `409 AUCTION_NOT_ACTIVE`.
- La comprobación se hace **dentro de la transacción**, después de aplicar `resolveAuctionStatus`.

### 8. Primera oferta ≥ precio inicial; siguientes ≥ oferta más alta + incremento mínimo.

- **Backend:** en `POST /api/bids`:
  - `highest = MAX(Bid.amount WHERE auctionId = ?)` (o `null`).
  - si `highest === null` → `amount >= auction.startingPrice`.
  - si `highest !== null` → `amount >= highest + auction.minIncrement`.
  - si no → `409 BID_TOO_LOW` con `{ minimumRequired }` en el body del error.

### 9. El postor con la oferta más alta no puede volver a ofertar.

- **Backend:** en `POST /api/bids`: si `highestBid.bidderId === session.user.id` → `409 ALREADY_HIGHEST_BIDDER`.
- Se verifica dentro de la transacción, tras calcular `highest`.

### 10. Las ofertas no se pueden editar ni eliminar.

- **Backend:** no existe `PATCH /api/bids/[id]` ni `DELETE /api/bids/[id]`.
- **BD:** `Bid` sin `updatedAt`; los registros son inmutables por contrato.
- **Frontend:** no se exponen acciones de edición/borrado en UI.

### 11. Si llega una oferta con ≤ 5 min para el cierre, se extiende 5 min (acumulativo).

- **Backend:** dentro de la misma transacción de `POST /api/bids`:
  ```
  if (auction.endsAt - now <= 5min) {
    newEndsAt = auction.endsAt + 5min
    UPDATE Auction SET endsAt = newEndsAt WHERE id = auction.id
  }
  ```
- Se aplica **después** de insertar la oferta, en la misma transacción. Se repite indefinidamente mientras lleguen ofertas dentro de la ventana.

---

## Cierre

### 12. Estados posibles: `ACTIVE`, `CLOSED`, `UNSOLD`, `CANCELLED`.

- **BD:** enum `AuctionStatus`.
- **Backend:** transiciones:
  - `ACTIVE → CLOSED` (llegó `endsAt` y hay bids).
  - `ACTIVE → UNSOLD` (llegó `endsAt` y no hay bids).
  - `ACTIVE → CANCELLED` (acción de vendedor sin bids, o de admin).
  - Estados finales: `CLOSED`, `UNSOLD`, `CANCELLED` no vuelven a `ACTIVE`.

### 13. El estado es correcto en cada consulta, sin cron ni procesos externos.

- **Backend:** función `resolveAuctionStatus(auction, bidCount)` invocada en:
  - `GET /api/auctions` (para cada subasta del listado).
  - `GET /api/auctions/[id]`.
  - `POST /api/bids` (antes de validar regla 7).
  - Cualquier lectura SSR (catálogo, detalle).
- Si `status === ACTIVE && now >= endsAt`:
  - `bidCount > 0` → `UPDATE status = CLOSED`.
  - `bidCount === 0` → `UPDATE status = UNSOLD`.
- Se persiste el cambio para que los filtros por `status` sigan siendo rápidos.
- **Frontend:** nunca decide el estado; lo recibe del backend.

---

## Cancelación y moderación

### 14. El vendedor cancela solo si no tiene ofertas.

- **Backend:** en `POST /api/auctions/[id]/cancel`:
  - `auction.sellerId === session.user.id` (si no, `403`).
  - `auction.status === ACTIVE && auction.endsAt > now()` (si no, `409 AUCTION_NOT_ACTIVE`).
  - `bidCount === 0` (si no, `409 AUCTION_HAS_BIDS`).
  - Setea `status = CANCELLED`, `cancellationReason = null` (no lo exige la regla para el vendedor).

### 15. El admin cancela cualquier subasta activa con motivo obligatorio.

- **Backend:** en `POST /api/admin/auctions/[id]/cancel`:
  - `session.user.role === ADMIN` (si no, `403`).
  - `auction.status === ACTIVE` (si no, `409 AUCTION_NOT_ACTIVE`).
  - `reason` requerido, `string` no vacío, longitud máxima (ej. 500) → si falta, `400 MISSING_CANCELLATION_REASON`.
  - Setea `status = CANCELLED`, `cancellationReason = reason`.

### 16. Subasta cancelada o cerrada no se elimina.

- **Backend:** no existe `DELETE /api/auctions/[id]`.
- **BD:** `Bid.auctionId → Auction.id` con `onDelete: Cascade` solo aplicaría si se borrara la subasta; al no existir endpoint de borrado, la cascada nunca se dispara en producción.
- Historial de bids y datos de subasta quedan intactos.

---

## Categorías

### 17. Categoría con subastas asociadas no se puede eliminar.

- **BD:** `Auction.categoryId → Category.id` con `onDelete: Restrict`.
- **Backend:** en `DELETE /api/admin/categories/[id]`: intenta borrar; captura `P2003` de Prisma → `409 CATEGORY_HAS_AUCTIONS`.

---

## Privacidad y seguridad

### 18. El historial público muestra monto y fecha, no nombre ni correo; alias parcial.

- **Backend:** en `GET /api/auctions/[id]/bids` se serializa:
  ```ts
  {
    id: string,
    amount: string,          // Decimal serializado
    createdAt: string,
    bidderAlias: string      // ej. "ju***z" derivado de user.name
  }
  ```
- Nunca se incluye `bidderId`, `email` ni `name` completo en esta respuesta.
- El alias se calcula en el backend, no en el frontend.

### 19. Un usuario no puede editar ni cancelar subastas de otro usuario.

- **Backend:** en `PATCH /api/auctions/[id]` y `POST /api/auctions/[id]/cancel`:
  comparar `auction.sellerId === session.user.id`. Si no → `403 FORBIDDEN`.
- El `id` en la URL no basta: siempre se contrasta con la sesión.

### 20. Un usuario solo ve el listado completo de sus propias ofertas.

- **Backend:** en `GET /api/me/bids`: `WHERE bidderId = session.user.id`.
- No existe endpoint público que liste bids por usuario.
- En `GET /api/auctions/[id]/bids` (público) se aplica la regla 18 (alias, sin identidad).

---

## Resumen por capa

| Capa             | Reglas                                                  |
| ---------------- | ------------------------------------------------------- |
| **Solo BD**      | 17                                                      |
| **BD + Backend** | 1, 3, 12                                                |
| **Solo Backend** | 2, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 18, 19, 20 |

Ninguna regla se garantiza solo en frontend.
