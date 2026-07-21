export function isPublicHttpUrl(value: string) {
  const url = new URL(value);
  if (!(url.protocol === "http:" || url.protocol === "https:")) return false;
  if (url.username || url.password) return false;
  const credentialPattern = /(?:token|secret|password|auth|session|api.?key|code)/i;
  if ([...url.searchParams.keys()].some((key) => credentialPattern.test(key))) {
    return false;
  }
  if (credentialPattern.test(url.hash)) return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
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
  const [a, b] = octets as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}
