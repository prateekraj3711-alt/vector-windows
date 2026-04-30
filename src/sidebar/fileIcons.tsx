import React from "react";
import { Icon } from "@iconify/react";

// Highest precedence: exact filename (lowercased) → icon name
const BY_NAME: Record<string, string> = {
  "package.json": "material-icon-theme:nodejs",
  "package-lock.json": "material-icon-theme:nodejs",
  "tsconfig.json": "material-icon-theme:tsconfig",
  "tsconfig.build.json": "material-icon-theme:tsconfig",
  "cargo.toml": "material-icon-theme:rust",
  "cargo.lock": "material-icon-theme:rust",
  "dockerfile": "material-icon-theme:docker",
  "docker-compose.yml": "material-icon-theme:docker",
  "docker-compose.yaml": "material-icon-theme:docker",
  ".gitignore": "material-icon-theme:git",
  ".gitattributes": "material-icon-theme:git",
  ".gitmodules": "material-icon-theme:git",
  "readme.md": "material-icon-theme:readme",
  "license": "material-icon-theme:certificate",
  "licence": "material-icon-theme:certificate",
  "yarn.lock": "material-icon-theme:yarn",
  "pnpm-lock.yaml": "material-icon-theme:pnpm",
  ".env": "material-icon-theme:tune",
  ".env.local": "material-icon-theme:tune",
  ".env.development": "material-icon-theme:tune",
  ".env.production": "material-icon-theme:tune",
};

// Extension (lowercased, without leading dot) → icon name
const BY_EXT: Record<string, string> = {
  ts: "material-icon-theme:typescript",
  tsx: "material-icon-theme:react-ts",
  js: "material-icon-theme:javascript",
  jsx: "material-icon-theme:react",
  mjs: "material-icon-theme:javascript",
  cjs: "material-icon-theme:javascript",
  rs: "material-icon-theme:rust",
  py: "material-icon-theme:python",
  go: "material-icon-theme:go",
  rb: "material-icon-theme:ruby",
  java: "material-icon-theme:java",
  kt: "material-icon-theme:kotlin",
  swift: "material-icon-theme:swift",
  c: "material-icon-theme:c",
  h: "material-icon-theme:h",
  cpp: "material-icon-theme:cpp",
  cc: "material-icon-theme:cpp",
  cxx: "material-icon-theme:cpp",
  hpp: "material-icon-theme:hpp",
  hxx: "material-icon-theme:hpp",
  md: "material-icon-theme:markdown",
  mdx: "material-icon-theme:mdx",
  json: "material-icon-theme:json",
  jsonc: "material-icon-theme:json",
  yaml: "material-icon-theme:yaml",
  yml: "material-icon-theme:yaml",
  toml: "material-icon-theme:toml",
  html: "material-icon-theme:html",
  htm: "material-icon-theme:html",
  css: "material-icon-theme:css",
  scss: "material-icon-theme:css",
  sass: "material-icon-theme:sass",
  less: "material-icon-theme:less",
  png: "material-icon-theme:image",
  jpg: "material-icon-theme:image",
  jpeg: "material-icon-theme:image",
  gif: "material-icon-theme:image",
  webp: "material-icon-theme:image",
  svg: "material-icon-theme:svg",
  pdf: "material-icon-theme:pdf",
  sh: "material-icon-theme:console",
  bash: "material-icon-theme:console",
  zsh: "material-icon-theme:console",
  fish: "material-icon-theme:console",
  sql: "material-icon-theme:database",
  vue: "material-icon-theme:vue",
  svelte: "material-icon-theme:svelte",
  graphql: "material-icon-theme:graphql",
  gql: "material-icon-theme:graphql",
  proto: "material-icon-theme:proto",
};

const FOLDER_ICON = "material-icon-theme:folder-base";
const FOLDER_OPEN_ICON = "material-icon-theme:folder-base-open";
const FILE_FALLBACK = "material-icon-theme:document";

export function FileIcon({
  name,
  isDir,
  isExpanded,
}: {
  name: string;
  isDir: boolean;
  isExpanded?: boolean;
}) {
  let iconName: string;
  if (isDir) {
    iconName = isExpanded ? FOLDER_OPEN_ICON : FOLDER_ICON;
  } else {
    const lower = name.toLowerCase();
    if (BY_NAME[lower]) {
      iconName = BY_NAME[lower];
    } else {
      const ext = lower.match(/\.([a-z0-9]+)$/)?.[1];
      iconName = (ext && BY_EXT[ext]) || FILE_FALLBACK;
    }
  }
  return <Icon icon={iconName} width={14} height={14} />;
}
