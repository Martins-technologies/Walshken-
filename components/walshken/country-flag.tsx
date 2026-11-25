import type { CSSProperties } from "react";
import countryCodes from "@/lib/country-codes.json";

const flagIndices = new Map(countryCodes.map(([code], index) => [code, index]));
const columns = 16;
const rows = Math.ceil(countryCodes.length / columns);

export function CountryFlag({ code }: { code: string }) {
  const index = flagIndices.get(code);
  if (index === undefined) return null;

  const style = {
    backgroundPosition: `${(index % columns) * 100 / (columns - 1)}% ${Math.floor(index / columns) * 100 / (rows - 1)}%`,
    backgroundSize: `${columns * 100}% ${rows * 100}%`,
  } satisfies CSSProperties;

  return <span className="country-flag" style={style} data-country-flag={code} aria-hidden="true"/>;
}
