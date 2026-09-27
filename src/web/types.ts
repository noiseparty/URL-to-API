export interface LinkRef { text: string; href: string }
export interface ImageRef { src: string; alt: string }
export interface TableOut { index: number; caption: string | null; headers: string[]; rows: Array<Record<string, string>>; rowCount: number; truncated: boolean }
export interface ListRecord { text: string; links: LinkRef[]; images: ImageRef[] }
export interface ListOut { index: number; selector: string; count: number; records: ListRecord[]; truncated: boolean }
export interface Extracted {
  title: string | null;
  meta: { description: string | null; canonical: string | null; lang: string | null; robots: string | null; openGraph: Record<string, string>; twitter: Record<string, string>; other: Record<string, string> };
  jsonLd: unknown[];
  tables: TableOut[];
  lists: ListOut[];
  headings: Array<{ level: number; text: string; id: string | null }>;
  links: Array<LinkRef & { internal: boolean }>;
  counts: { tables: number; lists: number; headings: number; links: number; jsonLd: number };
}
export interface ExtractResult {
  ok: true;
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  fetchedAt: string;
  redirects: Array<{ status: number; from: string; to: string }>;
  bytes: { wire: number; html: number };
  timing: { fetchMs: number; parseMs: number; totalMs: number };
  cached: boolean;
  data: Extracted;
}
export interface ApiError { ok: false; error: { code: string; message: string } }
