import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Bookmark, Heart, Info, Menu, PlusCircle, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { LoginArea } from '@/components/auth/LoginArea';
import { LogoMark } from '@/components/LogoMark';
import { SubmitToIndex } from '@/components/SubmitToIndex';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { ENGINE_PROFILE } from '@/lib/engine/profile';
import { cn } from '@/lib/utils';

interface LayoutProps {
  children: React.ReactNode;
  /** When true, the layout uses a minimal header (for the home search page). */
  minimal?: boolean;
}

const engine = ENGINE_PROFILE;

export function Layout({ children, minimal = false }: LayoutProps) {
  const location = useLocation();
  const [submitOpen, setSubmitOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { user } = useCurrentUser();

  // Bookmarks belong to the logged-in account — only surface the entry
  // point when there is one. Search is the logo. Settings lives in the
  // account menu. Content Policy stays in the footer only.
  const showBookmarks = engine.ui.showLogin && !!user;

  const menuIcon: Record<string, React.ReactNode> = {
    '/heaven': <Heart className="w-4 h-4" />,
    '/about': <Info className="w-4 h-4" />,
    '/bookmarks': <Bookmark className="w-4 h-4" />,
    '/partners': <UserPlus className="w-4 h-4" />,
  };

  const mobileLinks = [
    ...engine.ui.navLinks,
    ...(showBookmarks ? [{ to: '/bookmarks', label: 'Bookmarks' }] : []),
    ...engine.ui.footerLinks.filter((l) =>
      l.to !== '/settings' &&
      l.to !== '/policy' &&
      !engine.ui.navLinks.some((n) => n.to === l.to),
    ),
  ];

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-primary focus:text-primary-foreground focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none"
      >
        Skip to content
      </a>

      <header className={cn(
        'sticky top-0 z-40 pt-safe border-b border-border/50 backdrop-blur-xl bg-background/80',
        minimal && 'border-transparent bg-transparent backdrop-blur-none',
      )}>
        <div className="container flex items-center justify-between h-14 gap-4">
          <Link to="/" className="flex items-center gap-2.5 shrink-0 group" aria-label={`${engine.branding.name} home`}>
            <LogoMark className="w-8 h-8 rounded-lg group-hover:scale-105 transition-transform" />
            <span className="font-display font-semibold text-xl tracking-[0.2em]">
              {engine.branding.wordmark}
            </span>
          </Link>

          {/* Site menu — one menu on every screen size: account + hamburger
              opening the nav sheet. No orphan links, no desktop-only cluster. */}
          <nav className="flex items-center gap-1" aria-label="Site">
            {engine.ui.showSubmit && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSubmitOpen(true)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Submit a link to the community index"
              >
                <PlusCircle className="w-4 h-4 sm:mr-1.5" />
                <span className="hidden sm:inline">Submit</span>
              </Button>
            )}

            {engine.ui.showLogin && <LoginArea className="max-w-48" />}

            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  aria-label="Open navigation menu"
                >
                  <Menu className="w-5 h-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-72">
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2">
                    <LogoMark className="w-6 h-6 rounded-md" />
                    <span className="font-display tracking-[0.18em]">{engine.branding.wordmark}</span>
                  </SheetTitle>
                </SheetHeader>
                <nav className="flex flex-col gap-1 px-4 pb-6" aria-label="Mobile">
                  {mobileLinks.map((link) => (
                    <Link
                      key={link.to}
                      to={link.to}
                      onClick={() => setMenuOpen(false)}
                      className={cn(
                        'flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors',
                        (link.to === '/' ? location.pathname === '/' : location.pathname.startsWith(link.to)) &&
                          'text-foreground bg-accent/50 font-medium',
                      )}
                    >
                      {menuIcon[link.to]}
                      {link.label}
                    </Link>
                  ))}
                </nav>
              </SheetContent>
            </Sheet>
          </nav>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>

      <footer className="border-t border-border/50 py-6 pb-safe-or-6">
        <div className="container flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2 text-center sm:text-left">
            <span className="font-display font-semibold tracking-[0.16em] text-foreground/80">{engine.branding.wordmark}</span>
            <span className="text-border">|</span>
            <span>{engine.ui.footerTagline}</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            {engine.ui.footerLinks.map((link) => (
              <Link key={link.to} to={link.to} className="hover:text-foreground transition-colors">
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </footer>

      {engine.ui.showSubmit && (
        <SubmitToIndex open={submitOpen} onOpenChange={setSubmitOpen} />
      )}
    </div>
  );
}
