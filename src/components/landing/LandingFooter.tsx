import Image from 'next/image';
import Link from 'next/link';
import { REPO_URL } from './repo-url';

/** Minimal footer — logo, AGPL-3.0 line, GitHub link. No link farm (§5.7). */
export function LandingFooter() {
  return (
    <footer data-testid="landing-footer" className="border-t border-white/10 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-6 text-center text-sm text-white/60">
        <Link href="/" className="flex items-center gap-2" aria-label="AgentCanvas home">
          <Image src="/logo.svg" alt="AgentCanvas logo" width={20} height={20} />
          <span className="font-semibold text-white">AgentCanvas</span>
        </Link>
        <p>Released under the AGPL-3.0 license. Free and open source, forever.</p>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="footer-github"
          className="underline-offset-4 transition-colors hover:text-white hover:underline"
        >
          github.com/kanishka-namdeo/co-canvas
        </a>
      </div>
    </footer>
  );
}
