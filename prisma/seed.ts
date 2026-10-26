import { auth } from "../lib/auth";
import prisma from "../lib/prisma";

async function main() {
  console.log("Iniciando seed...");

  // 1. Crear Admin usando Better Auth (esto encripta la contraseña automáticamente)
  const adminEmail = "admin@bidhub.com";
  const existingAdmin = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (!existingAdmin) {
    await auth.api.signUpEmail({
      body: {
        email: adminEmail,
        password: "Admin123!",
        name: "Administrador",
      },
    });
    // Le asignamos el rol de ADMIN (por defecto Better Auth crea USER)
    await prisma.user.update({
      where: { email: adminEmail },
      data: { role: "ADMIN" },
    });
    console.log("Admin creado: admin@bidhub.com / Admin123!");
  }

  // 2. Crear Categorías
  const categories = await Promise.all([
    prisma.category.upsert({
      where: { slug: "cartas" },
      update: {},
      create: { name: "Cartas", slug: "cartas" },
    }),
    prisma.category.upsert({
      where: { slug: "relojes" },
      update: {},
      create: { name: "Relojes", slug: "relojes" },
    }),
    prisma.category.upsert({
      where: { slug: "vinilos" },
      update: {},
      create: { name: "Vinilos", slug: "vinilos" },
    }),
  ]);
  console.log("Categorías creadas");

  // 3. Crear un Vendedor de prueba (para las subastas)
  const sellerEmail = "vendedor@bidhub.com";
  let seller = await prisma.user.findUnique({ where: { email: sellerEmail } });

  if (!seller) {
    await auth.api.signUpEmail({
      body: {
        email: sellerEmail,
        password: "Seller123!",
        name: "Vendedor de Prueba",
      },
    });
    seller = await prisma.user.findUnique({ where: { email: sellerEmail } });
  }

  // 4. Crear Subastas
  if (seller) {
    // Subasta Activa (cierra en 2 días)
    await prisma.auction.create({
      data: {
        title: "Carta Charizard 1st Edition",
        description: "Carta en perfecto estado, edición original.",
        imageUrl: "https://placehold.co/600x400/png",
        startingPrice: 1000.0,
        minIncrement: 50.0,
        endsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        sellerId: seller.id,
        categoryId: categories[0].id, // Cartas
      },
    });

    // Subasta Desierta (ya cerró, sin ofertas)
    await prisma.auction.create({
      data: {
        title: "Reloj Rolex Vintage",
        description: "Reloj de colección, funciona perfectamente.",
        imageUrl: "https://placehold.co/600x400/png",
        startingPrice: 5000.0,
        minIncrement: 100.0,
        endsAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
        status: "UNSOLD",
        sellerId: seller.id,
        categoryId: categories[1].id,
      },
    });
    console.log("Subastas creadas");
  }

  console.log("Seed completado con éxito");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
