/**
 * Canonical KAEN legal-entity details used when a document template has not
 * supplied an explicit value yet. A template may still override each field;
 * hiding a field remains controlled by HeaderFieldFlags.
 */
export const LEGAL_DOCUMENT_PROFILE = {
  organizationName: "KAEN PROPERTIES MANAGEMENT SDN BHD",
  registrationNumber: "1610050-V",
  addressLines: [
    "No. 27-3, Jalan Perdana 10/12",
    "Pandan Perdana, 55300 Kuala Lumpur",
    "Malaysia",
  ],
  email: "kaenproperties@gmail.com",
  contact: "011-3611 1763",
} as const;

type LetterheadDetails = {
  orgRegNo: string | null;
  orgAddressLines: string[];
  orgEmail: string | null;
  orgContact: string | null;
};

/** Fill only genuinely missing letterhead values; configured values always win. */
export function withLegalDocumentDefaults<T extends LetterheadDetails>(value: T): T {
  const addressLines = value.orgAddressLines.map((line) => line.trim()).filter(Boolean);
  return {
    ...value,
    orgRegNo: value.orgRegNo?.trim() || LEGAL_DOCUMENT_PROFILE.registrationNumber,
    orgAddressLines:
      addressLines.length > 0 ? addressLines : [...LEGAL_DOCUMENT_PROFILE.addressLines],
    orgEmail: value.orgEmail?.trim() || LEGAL_DOCUMENT_PROFILE.email,
    orgContact: value.orgContact?.trim() || LEGAL_DOCUMENT_PROFILE.contact,
  };
}
