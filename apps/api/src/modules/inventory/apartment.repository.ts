import { getDb, Prisma } from "@kason/db";

export const APARTMENT_SELECT = {
  id: true,
  organizationId: true,
  propertyId: true,
  unitCode: true,
  listingMode: true,
  bedrooms: true,
  bathrooms: true,
  floorArea: true,
  floor: true,
  facing: true,
  furnishingLevel: true,
  amenities: true,
  highlights: true,
  publishedDescription: true,
  publishedTitle: true,
  tnbSubsidyCapMonthly: true,
  underManagement: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function findApartmentById(orgId: string, apartmentId: string) {
  return getDb().apartment.findFirst({
    where: { id: apartmentId, organizationId: orgId },
    select: APARTMENT_SELECT,
  });
}

export async function findApartmentByAddress(orgId: string, propertyId: string, unitCode: string) {
  return getDb().apartment.findFirst({
    where: { organizationId: orgId, propertyId, unitCode },
    select: APARTMENT_SELECT,
  });
}

export async function listApartmentsByProperty(orgId: string, propertyId: string) {
  return getDb().apartment.findMany({
    where: { organizationId: orgId, propertyId },
    select: APARTMENT_SELECT,
    orderBy: { unitCode: "asc" },
  });
}

export async function updateApartmentModeTx(
  tx: Prisma.TransactionClient,
  apartmentId: string,
  listingMode: "WHOLE" | "PARTITIONED",
) {
  return tx.apartment.update({
    where: { id: apartmentId },
    data: { listingMode },
    select: APARTMENT_SELECT,
  });
}

export type ApartmentSharedPatch = Partial<{
  bedrooms: number | null;
  bathrooms: Prisma.Decimal | number | string | null;
  floorArea: Prisma.Decimal | number | string | null;
  floor: number | null;
  facing: string | null;
  furnishingLevel: string | null;
  amenities: string[];
  highlights: string[];
  publishedDescription: string | null;
  publishedTitle: string | null;
  partitionBillingMode: "SUBSIDY" | "NO_SUBSIDY";
  tnbSubsidyCapMonthly: Prisma.Decimal | number | string | null;
  underManagement: boolean;
}>;

export async function updateApartmentSharedTx(
  tx: Prisma.TransactionClient,
  apartmentId: string,
  patch: ApartmentSharedPatch,
) {
  return tx.apartment.update({
    where: { id: apartmentId },
    data: patch as Prisma.ApartmentUpdateInput,
    select: APARTMENT_SELECT,
  });
}
