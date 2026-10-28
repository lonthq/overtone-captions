/** Null-prototype lookup table: keys such as "constructor" or "toString" must not resolve to Object.prototype members. */
export function dict<T>(entries: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}
