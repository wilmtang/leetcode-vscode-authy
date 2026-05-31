import * as vscode from "vscode";
import axios from "axios";
import { getLeetCodeEndpoint } from "../commands/plugin";
import { Endpoint } from "../shared";

const getTimeZone = (): string => {
    const endPoint: string = getLeetCodeEndpoint();
    if (endPoint === Endpoint.LeetCodeCN) {
        return "Asia/Shanghai";
    } else {
        return "UTC";
    }
};

interface IReportData {
    event_key: string;
    type?: "click" | "expose" | string;
    anonymous_id?: string;
    tid?: number;
    ename?: string;
    href?: string;
    referer?: string;
    extra?: string;
    target?: string;
}

interface ITrackData {
    reportCache: IReportData[];
    isSubmit: boolean;
    report: (reportItems: IReportData | IReportData[]) => void;
    submitReport: () => Promise<void>;
    reportUrl: string;
}

const testReportUrl = "https://analysis.lingkou.xyz/i/event";
const prodReportUrl = "https://analysis.leetcode.cn/i/event";

function getReportUrl(): string {
    if (process.env.NODE_ENV === "production") {
        return prodReportUrl;
    } else {
        return testReportUrl;
    }
}

const _charStr = "abacdefghjklmnopqrstuvwxyzABCDEFGHJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+=";

function RandomIndex(min: number, max: number, i: number): number {
    let index = Math.floor(Math.random() * (max - min + 1) + min);
    const numStart = _charStr.length - 10;
    if (i === 0 && index >= numStart) {
        index = RandomIndex(min, max, i);
    }
    return index;
}

function getRandomString(len: number): string {
    const min = 0;
    const max = _charStr.length - 1;
    let _str = "";
    len = len || 15;
    for (let i = 0, index; i < len; i++) {
        index = RandomIndex(min, max, i);
        _str += _charStr[index];
    }
    return _str;
}

function getAllowReportDataConfig(): boolean {
    const leetCodeConfig = vscode.workspace.getConfiguration("leetcode");
    return vscode.env.isTelemetryEnabled && !!leetCodeConfig.get<boolean>("allowReportData", false);
}

class TrackData implements ITrackData {
    public reportCache: IReportData[] = [];

    public isSubmit: boolean = false;

    public reportUrl: string = getReportUrl();

    private sendTimer: NodeJS.Timeout | undefined;

    public report = (reportItems: IReportData | IReportData[]): void => {
        if (!getAllowReportDataConfig()) return;

        this.sendTimer && clearTimeout(this.sendTimer);

        if (!Array.isArray(reportItems)) {
            reportItems = [reportItems];
        }
        const randomId = getRandomString(60);
        reportItems.forEach((item: IReportData) => {
            this.reportCache.push({
                ...item,
                referer: "vscode",
                anonymous_id: item.anonymous_id ?? randomId,
            });
        });
        this.sendTimer = setTimeout(this.submitReport, 800);
    };

    public submitReport = async (): Promise<void> => {
        if (!getAllowReportDataConfig()) return;
        const dataList = JSON.stringify(this.reportCache);

        if (!this.reportCache.length || this.isSubmit) {
            return;
        }
        this.reportCache = [];
        try {
            this.isSubmit = true;
            await axios.post(this.reportUrl, `dataList=${encodeURIComponent(dataList)}`, {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "x-timezone": getTimeZone(),
                },
            });
        } catch (e) {
            this.reportCache = this.reportCache.concat(JSON.parse(dataList));
        } finally {
            this.isSubmit = false;
        }
    };
}

export default new TrackData();
