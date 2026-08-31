import * as React from 'react';

import { cn } from '@/lib/utils';

export function Progress({
  value = 0,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { value?: number }) {
  const safe = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-secondary', className)}
      {...props}
    >
      <div
        className="h-full w-full flex-1 bg-primary transition-all duration-500"
        style={{ transform: `translateX(-${100 - safe}%)` }}
      />
    </div>
  );
}
