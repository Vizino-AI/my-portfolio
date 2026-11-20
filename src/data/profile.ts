interface Experience {
  period: string;
  company: string;
  url?: string;
  location: string;
  title: string;
  summary: string;
}

const experience: Experience[] = [
  {
    period: 'Apr — Jun 2026',
    company: 'Invest Ottawa',
    url: 'https://www.investottawa.ca/',
    location: 'Ottawa, Canada',
    title: 'Entrepreneurship Program Participant',
    summary:
      'Completed a program on entrepreneurship fundamentals — validating ideas, business models, and go-to-market — as part of the shift from engineering into founding a SaaS company.',
  },
  {
    period: '2025 — Present',
    company: 'Independent / Freelance',
    location: 'Ottawa, Canada',
    title: 'Software Engineer',
    summary:
      'Building SaaS products end to end for early-stage clients — architecture, implementation, and deployment.',
  },
  {
    period: '2022 — 2024',
    company: 'StraitsX',
    url: 'https://www.straitsx.com/',
    location: 'Singapore (Remote)',
    title: 'Software Engineer',
    summary:
      'Led a redesign of the core database schema that cut storage by 80% while making the system extensible to additional currencies and blockchains.',
  },
  {
    period: '2020 — 2022',
    company: 'Synergies Intelligent Systems',
    url: 'https://www.linkedin.com/company/synergies-intelligent-systems-inc/',
    location: 'Taiwan',
    title: 'Frontend Engineer',
    summary:
      'Built a natural-language input interface and the data-visualisation layer for an industrial analytics platform.',
  },
];

export const profile = {
  name: 'Katness Chen',
  /** Legal name. Not shown on the page; only in the Person JSON-LD (alternateName),
      so searches for it still find the site. */
  alias: 'Yu-Wen Chen',
  shortName: 'Katness Chen',
  /** Site/brand name — shown in the Nav, browser tab title, and social share cards.
      Distinct from `name`, which stays the actual person for the About page, footer
      attribution, and the Person JSON-LD schema. */
  brandName: 'Vizino AI',
  role: 'Helping non-technical founders turn vibe-coded prototypes into launch-ready MVPs.',
  location: 'Ottawa, Canada',
  email: 'contact@vizino.ai',
  linkedin: 'https://www.linkedin.com/in/yu-wen-chen-katness-chen-8340b9a4/',
  github: 'https://github.com/KatnessChen',
  resume: null as string | null,

  /** The studio in one sentence: the site's default meta description. */
  studioDescription:
    'Vizino AI is a technical studio that turns vibe-coded prototypes into launch-ready MVPs for non-technical founders.',

  /** The About page, in the studio's voice. */
  studioAbout: [
    'Vizino AI is a technical studio for non-technical founders. AI tools now let almost anyone vibe-code a convincing first version of a product. Getting from that prototype to an MVP that real users can rely on is a different job, and it is the job we do.',
    'That usually means the work a demo never shows: clear specs the AI can follow, checks that catch breakage before users do, costs that stay predictable, and the edge cases real customers find on day one. We find where your product is stuck, unblock it, and leave a foundation that you and your AI tools can keep building on.',
    'The studio grew out of six years of engineering at startups in Taiwan and Singapore and two years of freelance work, most of it taking SaaS products from an empty repository to a shipped MVP, across frontend, backend, databases and AI integration.',
  ],

  /** First-person bio and skills from when the site was a personal portfolio. Not shown anywhere now. */
  bioShort:
    "I am a software engineering based in Ottawa. Over six years at startups in Taiwan and Singapore, plus two years freelancing, I've taken SaaS products from nothing to MVP and out the door — across web frontend, backend, databases, and AI integration. I am looking to partner with non-technical founders to bridge the final mile of development, transforming their vibe-coded prototypes into highly robust, launch-ready MVPs that can scale and iterate rapidly.",

  bioLong: [
    "I am a software engineering based in Ottawa, Canada. I spent six years at startups in Taiwan and Singapore, followed by two years of freelancing — most of it on SaaS products taken from a blank repository to a shipped MVP.",
    "My work sits across the whole stack: interfaces in React and Vue, services in Nest.js and Node.js, relational and document data models, and deployments on GCP and AWS. The thread running through it is that I like owning a feature end to end, from the data model up to the pixel.",
    "More recently that has extended into integrating AI into products — both cloud-hosted models and locally-run ones — which is what most of the work below is about.",
    "Today, I focus on collaborating with non-technical founders. While AI allows almost anyone to 'vibe-code' an incredible initial proof-of-concept, taking a product across the finish line to become a truly workable, launch-ready MVP requires deep technical structure. I work closely with founders to pinpoint their technical hurdles, unblocking their workflows and establishing a solid foundation for rapid product iterations.",
  ],

  capabilities: [
    {
      title: 'Frontend',
      items: ['React', 'Vue', 'TypeScript', 'CSS', 'Responsive Web Design'],
    },
    {
      title: 'Backend & Infra',
      items: ['Nest.js', 'Node.js', 'Relational databases', 'NoSQL', 'Google Cloud Platform', 'AWS'],
    },
    {
      title: 'AI Integration',
      items: ['Claude Code', 'GitHub Copilot', 'Gemini'],
    },
  ],

  experience,
} as const;

export type Profile = typeof profile;
