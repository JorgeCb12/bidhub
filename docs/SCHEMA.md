# Modelo de datos de BidHub

Base de datos: PostgreSQL (Supabase). ORM: Prisma.

## Enums

```prisma
enum Role {
  USER
  ADMIN
}

enum AuctionStatus {
  ACTIVE
  CLOSED
  UNSOLD
  CANCELLED
}
```

## Entidades

### `User`

| Columna        | Tipo     | Restricciones             |
| -------------- | -------- | ------------------------- |
| `id`           | String   | PK, `cuid()`              |
| `email`        | String   | unique, not null          |
| `passwordHash` | String   | not null                  |
| `name`         | String   | not null                  |
| `role`         | Role     | not null, default `USER`  |
| `createdAt`    | DateTime | not null, default `now()` |
| `updatedAt`    | DateTime | not null, `@updatedAt`    |

Relaciones:

- `auctions Auction[]` (como vendedor)
- `bids Bid[]`
- `refreshTokens RefreshToken[]`

---

### `RefreshToken`

| Columna     | Tipo     | Restricciones             |
| ----------- | -------- | ------------------------- |
| `id`        | String   | PK, `cuid()`              |
| `tokenHash` | String   | unique, not null          |
| `userId`    | String   | FK → `User.id`, not null  |
| `expiresAt` | DateTime | not null                  |
| `revokedAt` | DateTime | nullable                  |
| `createdAt` | DateTime | not null, default `now()` |

Relación:

- `user User @relation(fields: [userId], references: [id], onDelete: Cascade)`

Índices:

- `@@index([userId])`

---

### `Category`

| Columna     | Tipo     | Restricciones             |
| ----------- | -------- | ------------------------- |
| `id`        | String   | PK, `cuid()`              |
| `name`      | String   | unique, not null          |
| `slug`      | String   | unique, not null          |
| `createdAt` | DateTime | not null, default `now()` |

Relación:

- `auctions Auction[]`

---

### `Auction`

| Columna              | Tipo          | Restricciones                |
| -------------------- | ------------- | ---------------------------- |
| `id`                 | String        | PK, `cuid()`                 |
| `title`              | String        | not null                     |
| `description`        | String        | not null                     |
| `imageUrl`           | String        | not null                     |
| `startingPrice`      | Decimal(10,2) | not null, `> 0`              |
| `minIncrement`       | Decimal(10,2) | not null, `> 0`              |
| `status`             | AuctionStatus | not null, default `ACTIVE`   |
| `endsAt`             | DateTime      | not null                     |
| `cancellationReason` | String        | nullable                     |
| `sellerId`           | String        | FK → `User.id`, not null     |
| `categoryId`         | String        | FK → `Category.id`, not null |
| `createdAt`          | DateTime      | not null, default `now()`    |
| `updatedAt`          | DateTime      | not null, `@updatedAt`       |

Relaciones:

- `seller User @relation(fields: [sellerId], references: [id], onDelete: Restrict)`
- `category Category @relation(fields: [categoryId], references: [id], onDelete: Restrict)`
- `bids Bid[]`

Índices:

- `@@index([status, endsAt])`
- `@@index([sellerId])`
- `@@index([categoryId])`

Notas:

- `cancellationReason` es `null` salvo que la subasta esté `CANCELLED` (regla 15 exige motivo al cancelar como admin; el vendedor también puede cancelar sin ofertas — ver `REGLAS.md`).
- `imageUrl` es única por subasta (no hay galería).

---

### `Bid`

| Columna     | Tipo          | Restricciones               |
| ----------- | ------------- | --------------------------- |
| `id`        | String        | PK, `cuid()`                |
| `amount`    | Decimal(10,2) | not null, `> 0`             |
| `auctionId` | String        | FK → `Auction.id`, not null |
| `bidderId`  | String        | FK → `User.id`, not null    |
| `createdAt` | DateTime      | not null, default `now()`   |

Relaciones:

- `auction Auction @relation(fields: [auctionId], references: [id], onDelete: Cascade)`
- `bidder User @relation(fields: [bidderId], references: [id], onDelete: Restrict)`

Índices:

- `@@index([auctionId, amount(sort: Desc)])`
- `@@index([bidderId, createdAt(sort: Desc)])`

---

## Relaciones (resumen)

```
User 1───N Auction       (sellerId, Restrict)
User 1───N Bid           (bidderId, Restrict)
User 1───N RefreshToken  (userId, Cascade)
Category 1───N Auction   (categoryId, Restrict)
Auction 1───N Bid        (auctionId, Cascade)
```

---

## Decisiones de diseño

1. **Regla 13 — estado derivado sin cron.**
   `Auction.status` se persiste, pero se recalcula en cada lectura con una función `resolveAuctionStatus(auction, bidCount)`: si `status = ACTIVE` y `now >= endsAt`, pasa a `CLOSED` (con bids) o `UNSOLD` (sin bids), y se hace `UPDATE` en BD. `CANCELLED` solo por acción explícita. Esto satisface la regla 13 sin tareas programadas y mantiene filtros rápidos por `status`.

2. **Regla 8 — oferta más alta por query.**
   No se desnormaliza `currentHighestBid`. Se calcula con `MAX(amount)` sobre `Bid WHERE auctionId = ?`, apoyado por el índice `(auctionId, amount DESC)`.

3. **Regla 11 — extensión de 5 min.**
   Se ejecuta dentro de la transacción de `POST /api/bids`: si `endsAt - now <= 5min`, se suma 5 min a `endsAt`. Acumulativo.

4. **Reglas 4, 8, 9, 19 — validación en backend.**
   No son expresables como constraints de BD. Se validan en el handler dentro de una transacción.

5. **Regla 17 — constraint de BD.**
   `Auction.categoryId` con `onDelete: Restrict`. La BD rechaza el borrado; el handler traduce a `409`.

6. **Dinero con `Decimal(10,2)`.** No `Float`, no `Int` en centavos (Prisma maneja `Decimal` de forma nativa y evita redondeos).

7. **Imagen única por subasta.** `imageUrl: string`. Sin tabla `AuctionImage`.
