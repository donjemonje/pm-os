import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowUpDown,
  BarChart3,
  BookOpen,
  CheckCircle,
  CircleDot,
  DollarSign,
  Flag,
  Flame,
  Gauge,
  GraduationCap,
  Layers,
  LifeBuoy,
  Lightbulb,
  LineChart,
  Megaphone,
  MessageSquare,
  Network,
  PenTool,
  Presentation,
  Radar,
  Trophy,
  Unlock,
  Users,
} from "lucide-react";

export type PillarCapability = {
  Icon: LucideIcon;
  label: string;
  description: string;
};

export type PillarCard = {
  id: string;
  name: string;
  tagline: string;
  Icon: LucideIcon;
  accent: string;
  capabilities: PillarCapability[];
};

export const PILLAR_CARDS: PillarCard[] = [
  {
    id: "discovery",
    name: "Discovery & Ideation",
    tagline: "Find the right problems.",
    Icon: Lightbulb,
    accent: "oklch(0.82 0.13 200)",
    capabilities: [
      {
        Icon: MessageSquare,
        label: "Interviews Analysis",
        description: "Transcribes and clusters user interviews into ranked themes.",
      },
      {
        Icon: Radar,
        label: "Competitors Analysis",
        description: "Tracks rivals and surfaces feature gaps continuously.",
      },
      {
        Icon: LineChart,
        label: "Data-Driven Insights",
        description: "Turns product data into opportunities worth pursuing.",
      },
    ],
  },
  {
    id: "design",
    name: "Design & Delivery",
    tagline: "Ship the right solution.",
    Icon: Layers,
    accent: "oklch(0.76 0.13 255)",
    capabilities: [
      {
        Icon: PenTool,
        label: "PRD & Design Generation",
        description: "Drafts PRDs and design briefs from a single prompt.",
      },
      {
        Icon: CheckCircle,
        label: "Product Review",
        description: "Reviews specs and designs against your standards.",
      },
      {
        Icon: ArrowUpDown,
        label: "Prioritization",
        description: "Scores the backlog by impact, effort, and fit.",
      },
    ],
  },
  {
    id: "operations",
    name: "Operations & Support",
    tagline: "Keep delivery unblocked.",
    Icon: LifeBuoy,
    accent: "oklch(0.80 0.13 165)",
    capabilities: [
      {
        Icon: Unlock,
        label: "Unblocking Developers",
        description: "Answers spec questions and clears blockers in-thread.",
      },
      {
        Icon: Flame,
        label: "Firefighting / Code Creeps",
        description: "Flags regressions and scope creep before release.",
      },
      {
        Icon: Users,
        label: "Ad-Hoc Meetings",
        description: "Captures meetings and turns them into action items.",
      },
    ],
  },
  {
    id: "sync",
    name: "Sync & Visibility",
    tagline: "Keep everyone aligned.",
    Icon: Network,
    accent: "oklch(0.76 0.14 290)",
    capabilities: [
      {
        Icon: BookOpen,
        label: "UM / RN",
        description: "Generates user manuals and release notes for every ship.",
      },
      {
        Icon: GraduationCap,
        label: "Training & Demos",
        description: "Builds enablement decks and demo scripts on demand.",
      },
      {
        Icon: CircleDot,
        label: "Product Status",
        description: "Keeps a live status of every initiative across teams.",
      },
    ],
  },
  {
    id: "evaluation",
    name: "Product Evaluation",
    tagline: "Measure what shipped.",
    Icon: Gauge,
    accent: "oklch(0.84 0.13 85)",
    capabilities: [
      {
        Icon: Activity,
        label: "Monitoring",
        description: "Watches metrics and alerts on anomalies automatically.",
      },
      {
        Icon: Trophy,
        label: "Post-Launch KPIs",
        description: "Grades launches against their target KPIs.",
      },
      {
        Icon: BarChart3,
        label: "Virtual Data Analyst",
        description: "Answers any product-data question in plain language.",
      },
    ],
  },
  {
    id: "business",
    name: "Business & Strategy",
    tagline: "Connect product to growth.",
    Icon: Flag,
    accent: "oklch(0.74 0.14 320)",
    capabilities: [
      {
        Icon: Presentation,
        label: "Deck Assistant",
        description: "Assembles board and strategy decks from your data.",
      },
      {
        Icon: DollarSign,
        label: "Pricing & Pricing Models",
        description: "Models pricing scenarios and packaging options.",
      },
      {
        Icon: Megaphone,
        label: "Marketing Positioning",
        description: "Crafts positioning and messaging per segment.",
      },
    ],
  },
];
