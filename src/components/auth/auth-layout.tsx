import type { ReactNode } from "react";
import logoUrl from "@/assets/renometa-connect-logo.png";

/**
 * Centered auth shell with a soft blue gradient mesh background.
 * Used by /signin, /signup, and /forgot-password.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div
      className="relative min-h-screen overflow-hidden"
      style={{
        background:
          "linear-gradient(135deg, oklch(0.97 0.025 250) 0%, oklch(0.94 0.045 240) 45%, oklch(0.92 0.06 225) 100%)",
      }}
    >
      {/* Gradient mesh background */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 -left-40 h-[620px] w-[620px] animate-pulse motion-reduce:animate-none rounded-full bg-[oklch(0.65_0.22_262)]/45 blur-[110px]" style={{ animationDuration: "8s" }} />
        <div className="absolute top-1/4 -right-52 h-[680px] w-[680px] animate-pulse motion-reduce:animate-none rounded-full bg-[oklch(0.72_0.18_220)]/55 blur-[120px]" style={{ animationDuration: "10s", animationDelay: "1s" }} />
        <div className="absolute -bottom-52 left-1/3 h-[600px] w-[600px] animate-pulse motion-reduce:animate-none rounded-full bg-[oklch(0.70_0.20_280)]/40 blur-[110px]" style={{ animationDuration: "12s", animationDelay: "2s" }} />
        <div className="absolute top-1/2 left-1/2 h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[oklch(0.85_0.10_200)]/35 blur-[90px]" />
        <div
          className="absolute inset-0 opacity-[0.4]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, oklch(0.40 0.15 262 / 0.12) 1px, transparent 0)",
            backgroundSize: "28px 28px",
          }}
        />
      </div>

      <div className="relative flex min-h-screen items-center justify-center px-4 py-10">
        <main className="w-full max-w-md" aria-labelledby="auth-title">
          <section className="rounded-2xl border border-border/60 bg-card/80 p-8 shadow-elev-2 backdrop-blur-xl sm:p-10">
            <header className="mb-6 flex flex-col items-center text-center">
              <img
                src={logoUrl}
                alt="RenoMeta Connect"
                className="mb-4 h-14 w-auto object-contain"
              />
              <h1 id="auth-title" className="text-2xl font-semibold tracking-tight">{title}</h1>
              {subtitle && (
                <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
              )}
            </header>
            {children}
          </section>

          {footer && (
            <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>
          )}

          <p className="mt-4 text-center text-xs text-muted-foreground">
            By continuing, you agree to our{" "}
            <a
              href="https://renometa.com/terms-of-service"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Terms of Service
            </a>{" "}
            and{" "}
            <a
              href="https://renometa.com/privacy-policy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Privacy Policy
            </a>
            .
          </p>
        </main>
      </div>
    </div>
  );
}

export function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.4 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.6 39.5 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.6l6.2 5.2C41.1 35.8 44 30.3 44 24c0-1.2-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}

export function AppleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      <path d="M16.365 1.43c0 1.14-.43 2.22-1.13 3-.74.83-1.94 1.47-2.92 1.39-.12-1.1.42-2.24 1.12-2.99.78-.84 2.07-1.46 2.93-1.4zM20.5 17.36c-.55 1.27-.81 1.84-1.52 2.97-.99 1.57-2.39 3.53-4.13 3.55-1.55.02-1.95-1.01-4.05-1-2.1.01-2.54 1.02-4.09 1-1.74-.02-3.07-1.78-4.06-3.35C.34 15.62-.21 9.45 2.83 6.41 4.27 4.94 6.16 4.07 7.94 4.07c1.83 0 2.98 1.01 4.49 1.01 1.47 0 2.36-1.01 4.48-1.01 1.59 0 3.27.87 4.47 2.37-3.93 2.16-3.29 7.79-.88 10.92z" />
    </svg>
  );
}