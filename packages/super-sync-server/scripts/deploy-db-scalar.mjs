import prismaClientPkg from '@prisma/client';

const { PrismaClient } = prismaClientPkg;

// Scalar deploy probe: print the first column of the first row, or nothing when
// the query returns no rows. deploy.sh treats empty output as "not present".
const sql = process.argv[2];

if (!sql) {
  console.error('Usage: node scripts/deploy-db-scalar.mjs <sql>');
  process.exit(1);
}

const prisma = new PrismaClient();

try {
  const rows = await prisma.$queryRawUnsafe(sql);
  const firstRow = Array.isArray(rows) ? rows[0] : undefined;

  if (firstRow) {
    const [value] = Object.values(firstRow);
    if (value !== null && value !== undefined) {
      process.stdout.write(String(value));
    }
  }
} finally {
  await prisma.$disconnect();
}
