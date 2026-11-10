import { cn } from '../../lib/cn';

export function Card({ className, children, ...props }) {
  return (
    <section
      className={cn(
        'rounded-xl border border-[var(--dl-border)] bg-[var(--dl-surface)] shadow-dl-soft',
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}

export function CardHeader({ className, children, ...props }) {
  return (
    <div
      className={cn('flex items-center justify-between gap-3', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...props }) {
  return (
    <h2 className={cn('m-0 text-[13px] font-bold', className)} {...props}>
      {children}
    </h2>
  );
}
