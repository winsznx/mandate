import type { Metadata } from "next";
import { ActivateWizard } from "../../../src/components/activate-wizard";
import { Page, SiteFooter } from "../../../src/components/site-chrome";

export const dynamic = "force-dynamic";

interface ActivatePageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: ActivatePageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Activate ${slug} — MANDATE`,
    description: `Configure strategy parameters and grant bounded session authority for ${slug}.`,
  };
}

export default async function ActivatePage({ params }: ActivatePageProps) {
  const { slug } = await params;

  return (
    <Page current="/marketplace">
      <main id="main">
        <div className="section__head">
          <span className="eyebrow">5-Step Mandate Activation Wizard</span>
        </div>
        <h1 className="display-sm">Activate Agent: {slug}</h1>
        <p className="lede">
          Configure your strategy goal, execute a fork trial, inspect authority matching, and grant bounded session permissions on BSC Testnet.
        </p>

        <ActivateWizard slug={slug} />
      </main>

      <SiteFooter />
    </Page>
  );
}
