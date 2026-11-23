const key = (name: string) => `report-desk.v1.${name}`;

export function readLocal<T>(name: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key(name)) ?? 'null') ?? fallback; }
  catch { return fallback; }
}

export function writeLocal(name: string, value: unknown) {
  localStorage.setItem(key(name), JSON.stringify(value));
}

export function removeLocal(name: string) {
  localStorage.removeItem(key(name));
}
