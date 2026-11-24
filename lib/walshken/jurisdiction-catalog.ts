export const employmentCountries = {
  CA: { name: "Canada", currency: "CAD" },
  IN: { name: "India", currency: "INR" },
  PK: { name: "Pakistan", currency: "PKR" },
} as const;

export const initialJurisdictions = [
  { code: "CA-AB", name: "Alberta, Canada", source: "https://www.alberta.ca/employment-standards", engine: "Alberta standard engine" },
  { code: "IN-DL", name: "Delhi, India", source: "https://labour.delhi.gov.in/labour/delhi-shops-act-1954-0", engine: "Separate validated engine required" },
  { code: "PK-PB", name: "Punjab, Pakistan", source: "https://invest.gov.pk/FAQS", engine: "Separate validated engine required" },
];
