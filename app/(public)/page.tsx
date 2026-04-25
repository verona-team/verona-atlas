import Link from "next/link";
import { InteractiveLogo } from "@/components/landing/interactive-logo";
import { UrlTestInput } from "@/components/landing/url-test-input";

export default function LandingPage() {
  return (
    <div className="relative min-h-screen bg-white">
      <header className="relative z-10 flex items-center justify-end px-6 py-5 sm:px-10">
        <nav className="flex items-center gap-5">
          <Link
            href="/signup"
            className="text-[15px] font-medium text-[#1a1a1a] hover:text-[#1a1a1a]/70 transition-colors"
          >
            Sign Up
          </Link>
          <Link
            href="/login"
            className="rounded-full border border-[#1a1a1a]/30 px-4 py-1.5 text-[15px] font-medium text-[#1a1a1a] hover:border-[#1a1a1a]/50 transition-colors"
          >
            Log In
          </Link>
        </nav>
      </header>

      <main
        className="relative z-10 flex flex-1 flex-col items-center justify-center px-6"
        style={{ minHeight: "calc(100vh - 68px)" }}
      >
        <div className="flex w-full max-w-xl flex-col items-center -mt-16">
          <div className="flex flex-col items-center gap-9">
            <InteractiveLogo size={120} />
            <h1 className="max-w-xl text-center text-3xl font-normal leading-[1.15] tracking-tight text-[#1a1a1a] sm:text-4xl">
              Verona bug bashes your product like a human
            </h1>
          </div>

          <div className="mt-10 w-full">
            <UrlTestInput />
          </div>
        </div>
      </main>
    </div>
  );
}
