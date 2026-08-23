import { z } from "zod";
import { PERMISSION_CATALOG } from "../../lib/permissions";

const permissionCodes = PERMISSION_CATALOG.map(([code]) => code) as [string, ...string[]];
// Zod 4 treats `z.record(z.enum(...), value)` as an exhaustive record and
// therefore requires every permission code to be present. Permission
// overrides are intentionally sparse: an empty object means "use the role
// defaults", while only customised permissions are stored. Use
// `partialRecord` so omitted permission codes remain valid.
const permissionOverridesSchema = z.partialRecord(z.enum(permissionCodes), z.boolean()).default({});

export const createUserSchema = z.object({
  email: z.string().email("Invalid email address"),
  fullName: z.string().min(1, "Full name is required"),
  role: z.enum(["director", "accountant", "manager", "editor", "viewer"], {
    error: 'Select Director, Finance, Manager, Operations Admin, or Viewer',
  }),
  password: z.string().min(6, "Password must be at least 6 characters"),
  permissionOverrides: permissionOverridesSchema.optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    fullName: z.string().min(1).max(200).optional(),
    role: z.enum(["director", "accountant", "manager", "editor", "viewer"]).optional(),
    permissionOverrides: permissionOverridesSchema.optional(),
  })
  .refine((d) => d.fullName !== undefined || d.role !== undefined || d.permissionOverrides !== undefined, {
    message: "At least one field must be provided",
  });

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const resetPasswordSchema = z.object({
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
