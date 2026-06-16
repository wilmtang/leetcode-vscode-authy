// Representative LeetCode GraphQL/REST payloads used as a regression net for the
// mappers in src/request/leetcode-api.ts. These mirror the field shapes selected
// by the queries in that module. They are hand-built rather than live-captured,
// so the tests need no cookie and stay deterministic; if a query's selection set
// changes, update the matching fixture here.

export const globalQuestionItem = {
    acRate: 49.1,
    difficulty: "Easy",
    frontendQuestionId: "1",
    isFavor: false,
    paidOnly: false,
    questionId: "1",
    status: "ac",
    title: "Two Sum",
    titleSlug: "two-sum",
    topicTags: [
        { name: "Array", slug: "array" },
        { name: "Hash Table", slug: "hash-table" },
    ],
};

export const globalQuestionItemLockedUnknown = {
    acRate: 35.2,
    difficulty: "HARD",
    frontendQuestionId: "4",
    isFavor: true,
    paidOnly: true,
    questionId: "4",
    status: null,
    title: "Median of Two Sorted Arrays",
    titleSlug: "median-of-two-sorted-arrays",
    topicTags: [],
};

export const cnQuestionItem = {
    acRate: 0.5,
    difficulty: "Medium",
    frontendQuestionId: "2",
    isFavor: true,
    paidOnly: false,
    status: "notac",
    title: "Add Two Numbers",
    titleCn: "两数相加",
    titleSlug: "add-two-numbers",
    topicTags: [
        { name: "Linked List", nameTranslated: "链表", slug: "linked-list" },
    ],
};

export const cnQuestionItemPercentPassThrough = {
    acRate: 73,
    difficulty: "easy",
    frontendQuestionId: "9",
    isFavor: false,
    paidOnly: false,
    status: "ac",
    title: "Palindrome Number",
    titleCn: "回文数",
    titleSlug: "palindrome-number",
    topicTags: [],
};

export const questionDetailItem = {
    codeSnippets: [
        { code: "class Solution {};", lang: "C++", langSlug: "cpp" },
        { code: "class Solution: pass", lang: "Python3", langSlug: "python3" },
    ],
    content: "<p>English content</p>",
    difficulty: "Easy",
    exampleTestcaseList: ["[2,7,11,15]\n9"],
    hints: ["Use a hash map."],
    questionFrontendId: "1",
    questionId: "1",
    sampleTestCase: "[2,7,11,15]\n9",
    stats: "{\"acRate\": \"49.1%\"}",
    title: "Two Sum",
    titleSlug: "two-sum",
    topicTags: [
        { name: "Array", nameTranslated: "数组", slug: "array" },
    ],
    translatedContent: "<p>中文题面</p>",
};

export const sessionItem = {
    ac_questions: 10,
    id: 123,
    is_active: true,
    name: "Primary",
    submitted_questions: 20,
    total_acs: 30,
    total_submitted: 60,
};

export const sessionItemAnonymousEmpty = {
    ac_questions: 0,
    is_active: false,
    submitted_questions: 0,
    total_acs: 0,
    total_submitted: 0,
};
