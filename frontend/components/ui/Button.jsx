import { cn } from '../../lib/cn';

const variants = {
  primary:
    'border border-[var(--dl-blue)] bg-[var(--dl-blue)] text-white shadow-dl-button hover:bg-[var(--dl-blue-dark)]',
  secondary:
    'border border-[var(--dl-border-strong)] bg-white text-[#345071] hover:bg-[#f7faff]',
  danger:
    'border border-[#f6c3cd] bg-[var(--dl-red-soft)] text-[var(--dl-red)] font-bold',
  text: 'border-0 bg-transparent text-[var(--dl-blue)] font-bold',
};

const sizes = {
  sm: 'px-[11px] py-[8px] text-[9px]',
  md: 'px-[13px] py-[9px] text-[10px]',
  text: 'px-[2px] py-[2px] text-[9px]',
};

export default function Button({
  variant = 'secondary',
  size = 'sm',
  className,
  children,
  ...props
}) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-[9px] whitespace-nowrap transition duration-150 ease-out disabled:cursor-default disabled:opacity-55 disabled:shadow-none',
        variants[variant] || variants.secondary,
        sizes[size] || sizes.sm,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
