import type { ComponentType, ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function PageContainer({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[1600px] space-y-5", className)}>{children}</div>;
}

export function SectionCard({
  title,
  description,
  icon: Icon,
  iconTone = "bg-primary-soft text-primary",
  action,
  children,
  className,
  contentClassName,
}: {
  title: string;
  description?: string;
  icon?: ComponentType<{ className?: string }>;
  iconTone?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <section className={cn("overflow-hidden rounded-xl border border-border/80 bg-card shadow-elev-1", className)}>
      <header className="flex min-h-13 items-center justify-between gap-4 border-b border-border/70 px-5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon && (
            <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", iconTone)}>
              <Icon className="h-4 w-4" />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold tracking-tight text-foreground">{title}</h2>
            {description && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{description}</p>}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className={cn("p-5", contentClassName)}>{children}</div>
    </section>
  );
}

export function SectionLink({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground">
      {children}<ArrowRight className="h-3 w-3" />
    </button>
  );
}
