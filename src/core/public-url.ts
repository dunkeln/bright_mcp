const CREDENTIAL_PARAMETERS = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "auth",
  "authorization",
  "session",
  "sessionid",
  "apikey",
  "code",
]);

export function isCredentialParameter(key: string) {
  return CREDENTIAL_PARAMETERS.has(key.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
}

export function isPublicHttpUrl(value: string) {
  const url = httpUrl(value);
  if (!url || !isPublicNetworkUrl(url)) return false;
  if (url.username || url.password) return false;
  if ([...url.searchParams.keys()].some(isCredentialParameter)) {
    return false;
  }
  const fragment = url.hash.slice(1);
  const fragmentQuery = fragment.includes("?")
    ? fragment.slice(fragment.indexOf("?") + 1)
    : fragment;
  return ![...new URLSearchParams(fragmentQuery).keys()].some(isCredentialParameter);
}

export function isPublicNetworkHttpUrl(value: string) {
  const url = httpUrl(value);
  return Boolean(url && isPublicNetworkUrl(url) && !url.username && !url.password);
}

function httpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function isPublicNetworkUrl(url: URL) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "home.arpa" ||
    hostname.endsWith(".home.arpa") ||
    (!hostname.includes(".") && !hostname.includes(":"))
  ) return false;
  if (
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("::ffff:") ||
    /^fe[89ab][0-9a-f]:/i.test(hostname) ||
    /^[fd][0-9a-f]:/i.test(hostname) ||
    hostname.startsWith("ff")
  ) {
    return false;
  }
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [a, b, c] = octets as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}
