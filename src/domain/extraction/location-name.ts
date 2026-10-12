const normalize = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\p{S}\s]/gu, "");

const stripAdministrativeQualifier = (value: string): string =>
  value
    .replace(/【[^】]*(?:都|道|府|県|市|区|町|村)[^】]*】$/u, "")
    .replace(/［[^］]*(?:都|道|府|県|市|区|町|村)[^］]*］$/u, "")
    .replace(/\[[^\]]*(?:都|道|府|県|市|区|町|村)[^\]]*\]$/u, "")
    .replace(/（[^）]*(?:都|道|府|県|市|区|町|村)[^）]*）$/u, "")
    .replace(/\([^)]*(?:都|道|府|県|市|区|町|村)[^)]*\)$/u, "")
    .trim();

export const locationIdentity = (value: string): string =>
  normalize(stripAdministrativeQualifier(value));

export const locationNameVariants = (value: string): string[] => {
  const administrativeSuffixRemoved = stripAdministrativeQualifier(value);
  const bracketIndex = [...administrativeSuffixRemoved].findIndex((character) =>
    ["【", "［", "[", "（", "(", "「", "『"].includes(character),
  );
  const venuePrefix =
    bracketIndex >= 0 ? administrativeSuffixRemoved.slice(0, bracketIndex) : "";
  return [...new Set([value, administrativeSuffixRemoved, venuePrefix].map(normalize))].filter(
    (variant) => variant.length >= 2,
  );
};

export const matchesLocationName = (text: string, locationName: string): boolean => {
  const normalizedText = normalize(text);
  return locationNameVariants(locationName).some((variant) =>
    normalizedText.includes(variant),
  );
};
