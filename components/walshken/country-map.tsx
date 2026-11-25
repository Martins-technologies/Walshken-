import outlines from "@/lib/walshken/country-outlines.json";
import { Icon } from "./brand";

export function CountryMap({ code, name }: { code: string; name: string }) {
  const outline = (outlines as Record<string, string>)[code];
  if (!outline) return null;

  return <figure className="country-map">
    <figcaption><Icon name="pin" size={19}/> Map of {name}</figcaption>
    <svg viewBox="0 0 580 320" aria-hidden="true" className="country-map-drawing">
      <path className="country-map-grid" d="M0 64H580 M0 128H580 M0 192H580 M0 256H580 M58 0V320 M116 0V320 M174 0V320 M232 0V320 M290 0V320 M348 0V320 M406 0V320 M464 0V320 M522 0V320"/>
      <path className="country-map-outline" d={outline} fillRule="evenodd"/>
    </svg>
    <div className="country-map-note">Generalized boundaries · <a href="https://www.naturalearthdata.com/">Natural Earth</a></div>
  </figure>;
}
