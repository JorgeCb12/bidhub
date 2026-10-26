# Contratos de endpoints de BidHub

## Convenciones

- **Base:** `/api`
- **Formato de error consistente:**
  ```json
  { "error": { "code": "ERROR_CODE", "message": "descripción", "details": {} } }
  ```
- **Auth:** cookie de sesión de Better Auth (gestionada por la librería).
- **Validación de sesión:** todos los handlers protegidos llaman a `auth.api.getSession({ headers })`. Si `null` → `401 UNAUTHORIZED`.
- **Validación de rol:** los handlers de admin comparan `session.user.role === "ADMIN"`. Si no → `403 FORBIDDEN`.
- **Serialización de `Decimal`:** se devuelve como `string` (ej. `"150.00"`), nunca como número.
- **Fechas:** ISO 8601 (`"2026-10-25T18:30:00.000Z"`).

---

## 1. Auth

Handlers propios que envuelven `auth.api`. Contratos originales del documento de requisitos, sin exponer rutas internas de Better Auth.

### POST `/api/auth/register`

- **Auth:** pública.
- **Request:**
  ```json
  { "email": "string", "password": "string", "name": "string" }
  ```
- **Response 201:**
  ```json
  {
    "user": {
      "id": "string",
      "email": "string",
      "name": "string",
      "role": "USER"
    }
  }
  ```
- **Errores:**
  - `400 VALIDATION_ERROR` — email inválido, password < 8, name vacío.
  - `409 EMAIL_ALREADY_EXISTS` — email ya registrado.
- **Notas:** `role` siempre `USER`. Admin solo por seed.

### POST `/api/auth/login`

- **Auth:** pública.
- **Request:**
  ```json
  { "email": "string", "password": "string" }
  ```
- **Response 200:**
  ```json
  {
    "user": {
      "id": "string",
      "email": "string",
      "name": "string",
      "role": "USER"
    }
  }
  ```
  Setea cookie de sesión (gestionada por Better Auth).
- **Errores:**
  - `400 VALIDATION_ERROR`
  - `401 INVALID_CREDENTIALS`

### POST `/api/auth/refresh`

- **Auth:** requiere cookie de sesión válida (aunque expirada, Better Auth la valida).
- **Request:** vacío.
- **Response 200:**
  ```json
  {
    "user": {
      "id": "string",
      "email": "string",
      "name": "string",
      "role": "string"
    }
  }
  ```
  Refresca la cookie.
- **Errores:**
  - `401 UNAUTHORIZED` — sin sesión o sesión revocada.

### POST `/api/auth/logout`

- **Auth:** requiere sesión.
- **Request:** vacío.
- **Response 204:** sin body. Revoca la sesión en BD y limpia cookie.
- **Errores:**
  - `401 UNAUTHORIZED`

### GET `/api/auth/me`

- **Auth:** requiere sesión.
- **Request:** vacío.
- **Response 200:**
  ```json
  {
    "user": {
      "id": "string",
      "email": "string",
      "name": "string",
      "role": "string"
    }
  }
  ```
- **Errores:**
  - `401 UNAUTHORIZED`

---

## 2. Subastas

### GET `/api/auctions`

- **Auth:** pública.
- **Query params:**
  - `category` (opcional): slug.
  - `status` (opcional): `ACTIVE` | `CLOSED` | `UNSOLD` | `CANCELLED`.
  - `page` (opcional, default 1).
  - `limit` (opcional, default 20, max 50).
- **Comportamiento:** antes de responder, ejecuta `resolveAuctionStatus` sobre cada subasta leída (regla 13).
- **Response 200:**
  ```json
  {
    "data": [
      {
        "id": "string",
        "title": "string",
        "imageUrl": "string",
        "startingPrice": "string",
        "minIncrement": "string",
        "status": "ACTIVE",
        "endsAt": "ISO",
        "category": { "id": "string", "name": "string", "slug": "string" },
        "sellerAlias": "string",
        "bidCount": 3,
        "currentHighestBid": "string | null"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 42 }
  }
  ```
- **Errores:**
  - `400 VALIDATION_ERROR` — query inválida.

### GET `/api/auctions/[id]`

- **Auth:** pública.
- **Comportamiento:** ejecuta `resolveAuctionStatus` antes de responder (regla 13).
- **Response 200:**
  ```json
  {
    "id": "string",
    "title": "string",
    "description": "string",
    "imageUrl": "string",
    "startingPrice": "string",
    "minIncrement": "string",
    "status": "ACTIVE",
    "endsAt": "ISO",
    "cancellationReason": "string | null",
    "category": { "id": "string", "name": "string", "slug": "string" },
    "seller": { "id": "string", "alias": "string" },
    "bidCount": 3,
    "currentHighestBid": "string | null",
    "createdAt": "ISO"
  }
  ```
- **Errores:**
  - `404 AUCTION_NOT_FOUND`

### POST `/api/auctions`

- **Auth:** requiere sesión.
- **Request:**
  ```json
  {
    "title": "string",
    "description": "string",
    "imageUrl": "string (URL)",
    "startingPrice": "string (decimal > 0)",
    "minIncrement": "string (decimal > 0)",
    "endsAt": "ISO",
    "categoryId": "string"
  }
  ```
- **Validaciones (todas en transacción):**
  - Reglas 1, 2, 3.
  - Regla 4: `COUNT(Auction WHERE sellerId = me AND status = ACTIVE AND endsAt > now()) < 5`.
- **Response 201:** igual al detalle (`GET /api/auctions/[id]`).
- **Errores:**
  - `400 VALIDATION_ERROR` — campos inválidos.
  - `401 UNAUTHORIZED`
  - `404 CATEGORY_NOT_FOUND`
  - `409 AUCTION_LIMIT_REACHED`

### PATCH `/api/auctions/[id]`

- **Auth:** requiere sesión (vendedor dueño).
- **Request:** cualquier subconjunto de los campos de creación (excepto `sellerId`).
- **Validaciones (reglas 5, 19):**
  - `auction.sellerId === session.user.id` → si no `403 FORBIDDEN`.
  - `status === ACTIVE && endsAt > now()` → si no `409 AUCTION_NOT_EDITABLE`.
  - `bidCount === 0` → si no `409 AUCTION_HAS_BIDS`.
  - Revalidar reglas 1 y 2 si se envían esos campos.
- **Response 200:** detalle actualizado.
- **Errores:**
  - `400 VALIDATION_ERROR`
  - `401 UNAUTHORIZED`
  - `403 FORBIDDEN`
  - `404 AUCTION_NOT_FOUND`
  - `409 AUCTION_NOT_EDITABLE` / `AUCTION_HAS_BIDS`

### POST `/api/auctions/[id]/cancel`

- **Auth:** requiere sesión (vendedor dueño).
- **Request:** vacío.
- **Validaciones (reglas 14, 19):**
  - `sellerId === session.user.id` → si no `403`.
  - `status === ACTIVE && endsAt > now()` → si no `409 AUCTION_NOT_ACTIVE`.
  - `bidCount === 0` → si no `409 AUCTION_HAS_BIDS`.
- **Response 200:** `{ "id": "string", "status": "CANCELLED" }`.
- **Errores:**
  - `401`, `403`, `404`, `409` (códigos arriba).

---

## 3. Ofertas

### POST `/api/bids`

- **Auth:** requiere sesión.
- **Request:**
  ```json
  { "auctionId": "string", "amount": "string (decimal > 0)" }
  ```
- **Validaciones (en transacción, reglas 6, 7, 8, 9, 11):**
  1. `resolveAuctionStatus` sobre la subasta.
  2. `auction.sellerId !== session.user.id` → si no `403 OWN_AUCTION_BID`.
  3. `status === ACTIVE && endsAt > now()` → si no `409 AUCTION_NOT_ACTIVE`.
  4. `highest = MAX(Bid.amount WHERE auctionId = ?)`.
  5. Si `highest === null`: `amount >= startingPrice` → si no `409 BID_TOO_LOW`.
  6. Si `highest !== null`: `amount >= highest + minIncrement` → si no `409 BID_TOO_LOW`.
  7. `highest.bidderId !== session.user.id` → si no `409 ALREADY_HIGHEST_BIDDER`.
  8. Si `endsAt - now <= 5min`: `endsAt = endsAt + 5min`. Persistir.
  9. Insertar `Bid`.
- **Response 201:**
  ```json
  {
    "id": "string",
    "amount": "string",
    "createdAt": "ISO",
    "auction": { "id": "string", "endsAt": "ISO", "status": "ACTIVE" }
  }
  ```
- **Errores:**
  - `400 VALIDATION_ERROR`
  - `401 UNAUTHORIZED`
  - `403 OWN_AUCTION_BID`
  - `404 AUCTION_NOT_FOUND`
  - `409 AUCTION_NOT_ACTIVE` / `BID_TOO_LOW` / `ALREADY_HIGHEST_BIDDER`
  - `409 BID_TOO_LOW` incluye `details.minimumRequired` en el body.

### GET `/api/auctions/[id]/bids`

- **Auth:** pública.
- **Query params:** `page`, `limit` (default 20, max 50).
- **Response 200:** historial con alias parcial (regla 18). Sin `bidderId`, `email` ni `name`.
  ```json
  {
    "data": [
      {
        "id": "string",
        "amount": "string",
        "createdAt": "ISO",
        "bidderAlias": "ju***z"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 12 }
  }
  ```
- **Errores:**
  - `404 AUCTION_NOT_FOUND`

### GET `/api/me/bids`

- **Auth:** requiere sesión.
- **Query params:** `page`, `limit` (default 20, max 50).
- **Response 200:** ofertas propias (regla 20). Incluye datos de subasta.
  ```json
  {
    "data": [
      {
        "id": "string",
        "amount": "string",
        "createdAt": "ISO",
        "auction": {
          "id": "string",
          "title": "string",
          "status": "ACTIVE",
          "endsAt": "ISO"
        },
        "isHighest": true
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 8 }
  }
  ```
- **Errores:**
  - `401 UNAUTHORIZED`

---

## 4. Categorías

### GET `/api/categories`

- **Auth:** pública.
- **Response 200:**
  ```json
  { "data": [{ "id": "string", "name": "string", "slug": "string" }] }
  ```

### POST `/api/admin/categories`

- **Auth:** requiere `ADMIN`.
- **Request:** `{ "name": "string" }` (slug se genera del name, único).
- **Response 201:** `{ "id": "string", "name": "string", "slug": "string" }`.
- **Errores:**
  - `400 VALIDATION_ERROR`
  - `401 UNAUTHORIZED`
  - `403 FORBIDDEN`
  - `409 CATEGORY_ALREADY_EXISTS`

### PATCH `/api/admin/categories/[id]`

- **Auth:** requiere `ADMIN`.
- **Request:** `{ "name": "string" }`.
- **Response 200:** categoría actualizada.
- **Errores:** `400`, `401`, `403`, `404 CATEGORY_NOT_FOUND`, `409 CATEGORY_ALREADY_EXISTS`.

### DELETE `/api/admin/categories/[id]`

- **Auth:** requiere `ADMIN`.
- **Validación (regla 17):** intentar borrar; capturar `P2003` de Prisma (FK `onDelete: Restrict`) → `409 CATEGORY_HAS_AUCTIONS`.
- **Response 204.**
- **Errores:** `401`, `403`, `404 CATEGORY_NOT_FOUND`, `409 CATEGORY_HAS_AUCTIONS`.

---

## 5. Moderación (admin)

### POST `/api/admin/auctions/[id]/cancel`

- **Auth:** requiere `ADMIN`.
- **Request:**
  ```json
  { "reason": "string (no vacío, max 500)" }
  ```
- **Validaciones (regla 15):**
  - `status === ACTIVE` → si no `409 AUCTION_NOT_ACTIVE`.
  - `reason` requerido → si no `400 MISSING_CANCELLATION_REASON`.
- **Response 200:** `{ "id": "string", "status": "CANCELLED", "cancellationReason": "string" }`.
- **Errores:** `400`, `401`, `403`, `404 AUCTION_NOT_FOUND`, `409 AUCTION_NOT_ACTIVE`.

---

## 6. Resumen de códigos de error

| Código                        | HTTP | Uso                                         |
| ----------------------------- | ---- | ------------------------------------------- |
| `VALIDATION_ERROR`            | 400  | Fallo de Zod o input malformado.            |
| `MISSING_CANCELLATION_REASON` | 400  | Admin cancela sin motivo.                   |
| `UNAUTHORIZED`                | 401  | Sin sesión.                                 |
| `INVALID_CREDENTIALS`         | 401  | Login incorrecto.                           |
| `FORBIDDEN`                   | 403  | Rol insuficiente o recurso ajeno.           |
| `OWN_AUCTION_BID`             | 403  | Ofertar en subasta propia (regla 6).        |
| `AUCTION_NOT_FOUND`           | 404  | Subasta inexistente.                        |
| `CATEGORY_NOT_FOUND`          | 404  | Categoría inexistente.                      |
| `EMAIL_ALREADY_EXISTS`        | 409  | Registro duplicado.                         |
| `CATEGORY_ALREADY_EXISTS`     | 409  | Nombre/slug duplicado.                      |
| `AUCTION_LIMIT_REACHED`       | 409  | 5 activas (regla 4).                        |
| `AUCTION_NOT_EDITABLE`        | 409  | Regla 5.                                    |
| `AUCTION_HAS_BIDS`            | 409  | Regla 5 o 14.                               |
| `AUCTION_NOT_ACTIVE`          | 409  | Regla 7, 14, 15.                            |
| `BID_TOO_LOW`                 | 409  | Regla 8. Incluye `details.minimumRequired`. |
| `ALREADY_HIGHEST_BIDDER`      | 409  | Regla 9.                                    |
| `CATEGORY_HAS_AUCTIONS`       | 409  | Regla 17.                                   |
