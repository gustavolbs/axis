const SAFE_INHERITED_ENVIRONMENT = new Set([
  'CI',
  'COLORTERM',
  'COMSPEC',
  'FORCE_COLOR',
  'HOME',
  'LANG',
  'LANGUAGE',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR',
  'JAVA_HOME',
  'JDK_HOME',
  'DOTNET_ROOT',
  'GOPATH',
  'GOROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'PNPM_HOME',
  'NVM_BIN',
  'VOLTA_HOME',
  'COREPACK_HOME',
  'VIRTUAL_ENV'
]);

const SENSITIVE_ENVIRONMENT_NAME =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|COOKIE|SESSION|PRIVATE_?KEY)(?:_|$)/i;

const SENSITIVE_ENVIRONMENT_PREFIXES = [
  'ANTHROPIC_',
  'AWS_',
  'AZURE_',
  'CLAUDE_',
  'GITHUB_',
  'GITLAB_',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'OPENAI_'
] as const;

export interface SanitizedProcessEnvironment {
  readonly env: NodeJS.ProcessEnv;
  readonly inheritedKeys: readonly string[];
  readonly overriddenKeys: readonly string[];
  readonly droppedKeys: readonly string[];
}

function canonicalEnvironmentName(name: string): string {
  return name.toUpperCase();
}

function assertEnvironmentName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid process environment variable name: ${name}`);
  }
}

export function isSensitiveProcessEnvironmentName(name: string): boolean {
  const canonical = canonicalEnvironmentName(name);
  return (
    SENSITIVE_ENVIRONMENT_NAME.test(canonical) ||
    SENSITIVE_ENVIRONMENT_PREFIXES.some((prefix) => canonical.startsWith(prefix))
  );
}

function isSafeInheritedEnvironmentName(name: string): boolean {
  const canonical = canonicalEnvironmentName(name);
  return SAFE_INHERITED_ENVIRONMENT.has(canonical) || canonical.startsWith('LC_');
}

function setEnvironmentValue(env: NodeJS.ProcessEnv, name: string, value: string): void {
  const canonical = canonicalEnvironmentName(name);
  for (const existing of Object.keys(env)) {
    if (canonicalEnvironmentName(existing) === canonical) delete env[existing];
  }
  env[name] = value;
}

/**
 * Builds a deliberately small child environment. Ambient credentials and arbitrary
 * application configuration are not inherited. Explicit overrides may add ordinary
 * variables but secret-shaped names remain blocked until a future vault-backed
 * permission path can supply them intentionally.
 */
export function sanitizeProcessEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>> = {}
): SanitizedProcessEnvironment {
  const env: NodeJS.ProcessEnv = {};
  const inheritedKeys: string[] = [];
  const droppedKeys: string[] = [];

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isSafeInheritedEnvironmentName(name) && !isSensitiveProcessEnvironmentName(name)) {
      setEnvironmentValue(env, name, value);
      inheritedKeys.push(name);
    } else {
      droppedKeys.push(name);
    }
  }

  const overriddenKeys: string[] = [];
  for (const [name, value] of Object.entries(overrides)) {
    assertEnvironmentName(name);
    if (isSensitiveProcessEnvironmentName(name)) {
      throw new Error(
        `Process environment variable ${name} is blocked because its name may carry a secret.`
      );
    }
    if (typeof value !== 'string') {
      throw new Error(`Process environment variable ${name} must be a string.`);
    }
    setEnvironmentValue(env, name, value);
    overriddenKeys.push(name);
  }

  return {
    env,
    inheritedKeys: Object.freeze(inheritedKeys.sort()),
    overriddenKeys: Object.freeze(overriddenKeys.sort()),
    droppedKeys: Object.freeze(droppedKeys.sort())
  };
}
