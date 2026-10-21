export const PORT = Number(process.env.PORT ?? 3000);
// where browsers reach this instance, e.g. https://xit.example.org
export const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN ?? `http://localhost:${PORT}`).replace(/\/$/, "");
export const PUBLIC_HOSTNAME = new URL(PUBLIC_ORIGIN).hostname;
