export type ConfigurationTransition = "auth-and-catalog" | "catalog-refetch" | "tree-rebuild" | "decorations" | "none";

export function getConfigurationTransition(key: string): ConfigurationTransition {
    switch (key) {
        case "leetcode.endpoint":
            return "auth-and-catalog";
        case "leetcode.useEndpointTranslation":
            return "catalog-refetch";
        case "leetcode.hideSolved":
        case "leetcode.problems.sortStrategy":
            return "tree-rebuild";
        case "leetcode.colorizeProblems":
            return "decorations";
        default:
            return "none";
    }
}
