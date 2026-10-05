export interface PortfolioLane {
  id: string;
  name: string;
  charter: string;
  accountablePerson: string | null;
  curatorAgent: string | null;
  slack?: { workspaceId: string; channelId: string };
}
export interface PortfolioSource {
  repository: string;
  path: string;
  digest: string;
}
export interface PortfolioSupportingFile {
  path: string;
  portfolioLane: string;
  inheritedFrom?: string;
}
export interface PortfolioView {
  source: PortfolioSource;
  lanes: PortfolioLane[];
  supportingFiles: PortfolioSupportingFile[];
}
export interface PortfolioMembership extends PortfolioView {
  assignments: Map<string, string>;
}
export const PORTFOLIO_LANES: readonly string[];
export function projectPortfolio(
  registryText: string,
  sourcePath: string,
  repository: string,
): {
  format: string;
  repository: string;
  source: PortfolioSource;
  lanes: PortfolioLane[];
  assignments: unknown[];
  supportingFiles: unknown[];
};
export function resolvePortfolio(
  root: string,
  policy: { repository: string; portfolio?: unknown },
  documents: { id: string; path: string; metadata?: Record<string, unknown> }[],
): PortfolioMembership | null;
export function portfolioView(portfolio: PortfolioMembership | null): PortfolioView | undefined;
