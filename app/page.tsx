import { redirect } from 'next/navigation';

// Root route: CAT exposes its tools under named paths (no bare "/" landing in
// the ported bundle). Send the bare domain to the primary tool so it never 404s.
export default function Home() {
  redirect('/ask');
}
