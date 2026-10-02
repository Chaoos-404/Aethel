// A device-local TTL cannot establish whether another device changed Drive.
// Commands that classify or stage changes must refresh remote observations.
// The Drive-side memo/change feed still avoids unnecessary full listings.
export function remoteCacheEnabledByDefault(_command) {
  return false;
}
