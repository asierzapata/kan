import { Link } from "@tanstack/react-router";
import { RiArrowLeftLine, RiHardDriveLine } from "@remixicon/react";
import { Badge } from "./ui/badge";
import { SignInButton } from "./SignInButton";
import { KanBrand } from "./KanBrand";

export interface HeaderBarProps {
  title?: string;
}

export function HeaderBar({ title }: HeaderBarProps) {
  return (
    <header className="header-bar">
      <Link
        to="/"
        className="header-bar__brand flex items-center gap-2 text-sm font-sans font-semibold text-muted-foreground hover:text-foreground transition-colors"
        title="Back to all canvases"
        aria-label="Back to all canvases"
      >
        <RiArrowLeftLine className="size-4" />
        <KanBrand />
      </Link>

      {title ? (
        <div className="flex min-w-0 items-center gap-3 border-l border-border pl-4">
          <span className="max-w-[200px] truncate font-sans text-base font-semibold tracking-tight sm:max-w-[320px]">
            {title}
          </span>
          <Badge variant="secondary" className="h-5 shrink-0 gap-1 px-1.5">
            <RiHardDriveLine className="size-3" /> Offline
          </Badge>
        </div>
      ) : null}

      <div className="header-bar__slot" />
      <div className="flex items-center gap-2">
        <SignInButton />
      </div>
    </header>
  );
}
