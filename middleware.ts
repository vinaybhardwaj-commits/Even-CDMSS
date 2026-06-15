import { NextResponse, type NextRequest } from 'next/server';

// Host-based routing. medaudit.evenos.app serves ONLY the Clinical Pharmacist
// audit surface; the bare domain rewrites to /audit and all other CAT routes are
// bounced back. The CAT host (even-cdmss.vercel.app / cat.*) is untouched.
// Pharmacist auth is enforced in the page/route layer (lib/pharmacist-cookie),
// not here, to keep the middleware off the Node crypto path.
export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') || '').toLowerCase();
  if (!host.startsWith('medaudit.')) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (pathname === '/') {
    const url = req.nextUrl.clone();
    url.pathname = '/audit';
    return NextResponse.rewrite(url);
  }
  const allowed =
    pathname.startsWith('/audit') ||
    pathname.startsWith('/api/audit') ||
    pathname.startsWith('/api/drugs'); // shared interaction engine
  if (allowed) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/audit';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|globals.css|icon.png).*)'],
};
