import type { AccountProfileStatus, AgentCli, Cli, KeyStatus } from "./ipc";

export const AUTO_ACCOUNT = "__auto__";
export const HOST_ACCOUNT = "__host__";

export function agentAccountState(
  agent: Cli,
  accountProfiles: AccountProfileStatus[],
  keyStatus: Partial<Record<AgentCli, KeyStatus>> | null | undefined,
  accountChoice: string,
) {
  const agentAccounts = accountProfiles.filter((p) => p.agent === agent);
  const defaultKey = agent === "shell" ? null : (keyStatus?.[agent as AgentCli] ?? null);
  const newestPresentAccount = [...agentAccounts].reverse().find((p) => p.present)?.id;
  const autoAccountChoice =
    defaultKey?.present || agentAccounts.length === 0
      ? HOST_ACCOUNT
      : (newestPresentAccount ?? HOST_ACCOUNT);
  const effectiveAccountChoice =
    accountChoice === AUTO_ACCOUNT ||
    (accountChoice !== HOST_ACCOUNT && !agentAccounts.some((p) => p.id === accountChoice))
      ? autoAccountChoice
      : accountChoice;
  const selectedAccount =
    effectiveAccountChoice === HOST_ACCOUNT ? undefined : effectiveAccountChoice;

  return {
    agentAccounts,
    defaultKey,
    effectiveAccountChoice,
    selectedAccount,
  };
}

export function accountProfileSubtitle(profile: AccountProfileStatus): string {
  if (profile.source === "vault") {
    return `keychain · ${profile.present ? "stored" : "missing"}`;
  }
  return `${profile.varName ?? "env"} · ${profile.present ? "present" : "missing"}`;
}
