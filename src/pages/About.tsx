import { Link } from 'react-router-dom';
import { useSeoMeta } from '@unhead/react';
import { Shield, Scale } from 'lucide-react';

import { Layout } from '@/components/Layout';
import { LogoMark } from '@/components/LogoMark';
import { Separator } from '@/components/ui/separator';
import { ENGINE_PROFILE } from '@/lib/engine/profile';

const engine = ENGINE_PROFILE;

export default function About() {
  useSeoMeta({
    title: `About - ${engine.branding.name}`,
    description: engine.branding.description,
  });

  return (
    <Layout>
      <div className="container max-w-2xl py-12">
        <div className="flex items-center gap-3 mb-3">
          <LogoMark className="w-10 h-10" />
          <h1 className="text-3xl font-display font-semibold tracking-tight">About {engine.branding.name}</h1>
        </div>
        <p className="font-display italic text-xl text-primary mb-1 leading-relaxed">
          {engine.branding.slogan}
        </p>
        <p className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground mb-8">
          Matthew 7:7
        </p>

        <Separator className="mb-8" />

        <section className="mb-10">
          <h2 className="text-xl font-display font-semibold mb-3">What SAVEDD is</h2>
          <p className="text-muted-foreground leading-relaxed mb-4">
            SAVEDD is a general search engine built for Christians—and for anyone who wants
            a more wholesome way to search the web. Look up whatever you would look up
            anywhere else: news, work, school, travel, products, local services, or
            Scripture. Nothing is fenced off. The aim is not a smaller internet. The aim is
            a better one—an information resource Christians can actually shape, instead of
            borrowing a window on the world that was never built with their convictions in
            mind.
          </p>
          <p className="text-muted-foreground leading-relaxed mb-4">
            A search box is not a pastor. It is not a denomination. It is not a source of
            revelation. It is a tool. SAVEDD exists so that tool can support what Christians
            believe, help them grow in what is good and true, and serve ordinary life without
            the cynicism, bait, and clutter that so often greet a query.
          </p>
          <p className="text-muted-foreground leading-relaxed mb-4">
            This is a work in progress. The more people use it, the clearer the picture
            becomes—of what belongs, what does not, and how the engine can better serve a
            Christian home. SAVEDD will improve as that community grows.
          </p>
          <p className="text-muted-foreground leading-relaxed mb-4">
            In time, the hope is larger than search. SAVEDD aims to become a place where
            Christian businesses can meet the people most aligned with their values—honest
            commerce in a setting that already takes faith seriously.
          </p>
          <p className="text-muted-foreground leading-relaxed mb-4">
            Created in honor of{' '}
            <a
              href="https://www.youtube.com/watch?v=95Z2On9XN6o"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Tom Devine
            </a>
            .
          </p>
          <p className="font-display italic text-lg text-primary leading-snug">
            Seek, and ye shall find.
          </p>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-display font-semibold mb-3 flex items-center gap-2">
            <Scale className="w-5 h-5 text-primary" />
            Scripture and interpretation
          </h2>
          <p className="text-muted-foreground leading-relaxed mb-3">
            When a question is theological, SAVEDD&apos;s AI is instructed to prioritize
            Scripture where the evidence includes it, identify chapter and verse accurately,
            and never fabricate a quotation. Biblical text is distinguished from commentary
            and from the model&apos;s own inference.
          </p>
          <p className="text-muted-foreground leading-relaxed mb-3">
            Christianity is not one denomination. Legitimate differences are acknowledged.
            Mainstream historic consensus is not presented as if it were the only Christian
            view, and a minority interpretation is not presented as Scripture itself.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            The AI is an assistant for Christian search. It is not a religious authority,
            does not claim divine revelation, and should say so when the evidence is weak.
          </p>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-display font-semibold mb-3 flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            Truthful sourcing
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            Search results show title, address, and snippet from the engines that returned
            them. AI answers must cite the evidence they used. SAVEDD does not invent
            sources. If a result is missing, the honest answer is that it is missing.
          </p>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-display font-semibold mb-3">Affiliate links</h2>
          <p className="text-muted-foreground leading-relaxed">
            Some outbound links on SAVEDD are affiliate links. If you buy through them,
            the merchant may pay SAVEDD a commission at no extra cost to you. That income
            keeps the engine running. As an Amazon Associate, SAVEDD earns from qualifying
            purchases.
          </p>
        </section>

        <section className="mb-4">
          <h2 className="text-xl font-display font-semibold mb-3">Open search infrastructure</h2>
          <p className="text-muted-foreground leading-relaxed mb-3">
            Underneath the SAVEDD interface is an open search stack: a shared SIP-01
            document index, community crawlers and indexers, and a structured query engine.
            That stack is not owned by SAVEDD. Other communities can launch their own
            engines on the same foundation.
          </p>
          <p className="text-sm text-muted-foreground">
            Protocol:{' '}
            <a
              href="https://github.com/NostrDanish/Dsearch/blob/main/docs/SIP-01.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              SIP-01
            </a>
            {' · '}
            <Link to="/settings" className="text-primary hover:underline">Settings</Link>
          </p>
        </section>
      </div>
    </Layout>
  );
}
