// Section 3 — Payout Summary
// Shows the waterfall lines (gross rental → deductions → net) and highlights
// the final net payout to owner in a prominent GlowCard figure.
import { DollarSign, Info, Minus, Plus, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GlowCard } from "@/components/ui/glow-card";
import { formatRM } from "@/components/format";
import type { YannieSections } from "@/api/owner-ledger";

interface Props {
  data: YannieSections["payoutSummary"];
}

type PayoutLine = YannieSections["payoutSummary"]["lines"][number];

function isDeductionLine(line: PayoutLine) {
  const amount = Number(line.amount);
  return /^Less:\s*/i.test(line.label) || (!Number.isNaN(amount) && amount < 0);
}

function displayLabel(label: string) {
  return label.replace(/^(Add|Less):\s*/i, "");
}

function AmountLine({
  line,
  tone,
}: {
  line: PayoutLine;
  tone: "addition" | "deduction" | "information";
}) {
  const amount = Number(line.amount);
  const value = Math.abs(Number.isNaN(amount) ? 0 : amount);
  const isSubtotal = line.label === "Gross Cash In";
  const amountPrefix = tone === "deduction" ? "− " : tone === "addition" && !isSubtotal ? "+ " : "";

  return (
    <div
      className={`flex items-center justify-between gap-4 px-4 py-3 ${
        isSubtotal ? "border-t border-emerald-200 bg-emerald-50/70 font-bold dark:border-emerald-900 dark:bg-emerald-950/20" : ""
      }`}
    >
      <span
        className={`text-sm ${
          tone === "deduction"
            ? "font-semibold text-red-700 dark:text-red-400"
            : isSubtotal
              ? "font-bold text-foreground"
              : "text-muted-foreground"
        }`}
      >
        {displayLabel(line.label)}
        {line.isNonIncome && (
          <span className="ml-2 text-xs font-normal text-muted-foreground">(non-income)</span>
        )}
      </span>
      <span
        className={`shrink-0 text-sm font-bold tabular-nums ${
          tone === "deduction"
            ? "text-red-700 dark:text-red-400"
            : tone === "addition"
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-foreground"
        }`}
      >
        {amountPrefix}{formatRM(value)}
      </span>
    </div>
  );
}

export function StatementSectionPayoutSummary({ data }: Props) {
  // DEV guard: required fields per frontend-design rule #16
  if (import.meta.env.DEV) {
    if (data.netPayoutToOwner === undefined)
      console.warn("[owner-statement/payout-summary] missing netPayoutToOwner from API response");
    if (data.lines === undefined)
      console.warn("[owner-statement/payout-summary] missing lines from API response");
  }

  const totalPayoutLine = data.lines.find((line) => line.label === "Total Payout to Owner");
  const totalPayout = Number(totalPayoutLine?.amount ?? data.netPayoutToOwner);
  const operatingBalance = Number(data.netPayoutToOwner);
  const isNegative = !isNaN(totalPayout) && totalPayout < 0;
  const detailLines = data.lines.filter((line) => !line.isTotal);
  const deductionLines = detailLines.filter(isDeductionLine);
  const informationLines = detailLines.filter(
    (line) => line.isNonIncome && !/^Add:\s*/i.test(line.label) && !isDeductionLine(line),
  );
  const additionLines = detailLines.filter(
    (line) => !isDeductionLine(line) && !informationLines.includes(line),
  );

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl font-bold flex items-center gap-2" id="section-heading-payout">
          <TrendingUp className="h-5 w-5 text-primary" />
          Payout Summary
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Addition and deduction lines are deliberately separated so an owner or
            checker never has to infer the direction from a label alone. */}
        <div className="grid gap-3 md:grid-cols-2">
          <section className="overflow-hidden rounded-lg border border-emerald-300/70 bg-background/40 dark:border-emerald-900">
            <div className="flex items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-bold text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
              <Plus className="h-4 w-4" />
              Additions (+)
            </div>
            <div className="divide-y divide-border/30">
              {additionLines.map((line, index) => (
                <AmountLine key={`addition-${index}`} line={line} tone="addition" />
              ))}
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border border-red-300/80 bg-red-50/30 dark:border-red-900 dark:bg-red-950/10">
            <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2.5 text-sm font-bold text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              <Minus className="h-4 w-4" />
              Deductions (−)
            </div>
            <div className="divide-y divide-red-200/70 dark:divide-red-900/70">
              {deductionLines.length > 0 ? deductionLines.map((line, index) => (
                <AmountLine key={`deduction-${index}`} line={line} tone="deduction" />
              )) : (
                <div className="px-4 py-3 text-sm text-muted-foreground">No deductions</div>
              )}
            </div>
          </section>
        </div>

        {informationLines.length > 0 && (
          <section className="overflow-hidden rounded-lg border border-border/50 bg-background/40">
            <div className="flex items-center gap-2 border-b border-border/40 bg-muted/40 px-4 py-2.5 text-sm font-bold text-foreground">
              <Info className="h-4 w-4" />
              Information only — not added or deducted
            </div>
            <div className="divide-y divide-border/30">
              {informationLines.map((line, index) => (
                <AmountLine key={`information-${index}`} line={line} tone="information" />
              ))}
            </div>
          </section>
        )}

        {totalPayoutLine && (
          <div className="flex items-center justify-between rounded-lg border border-[var(--gold)]/70 bg-background/60 px-4 py-3 font-bold">
            <span className="text-sm font-bold text-foreground">{totalPayoutLine.label}</span>
            <span className="text-base font-bold tabular-nums text-amber-600 dark:text-amber-500">
              {formatRM(totalPayout)}
            </span>
          </div>
        )}

        {/* The actual transfer is the decision figure. Deposits are not owner income,
            but they are still cash KAEN must transfer to the owner. */}
        <GlowCard
          glowColor="gold"
          className="p-5 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Total Cash Payout to Owner</p>
              <p
                className={`text-3xl font-bold tabular-nums ${
                  isNegative ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-500"
                }`}
              >
                {isNaN(totalPayout) ? "RM 0.00" : formatRM(totalPayout)}
              </p>
              {!isNaN(operatingBalance) && operatingBalance !== totalPayout && (
                <p className="text-xs text-muted-foreground">
                  Operating balance excluding deposit transfer: {formatRM(operatingBalance)}
                </p>
              )}
              {isNegative && (
                <p className="text-xs text-rose-600 dark:text-rose-400">
                  Negative — KAEN has fronted the shortfall
                </p>
              )}
            </div>
            <div className="p-3 rounded-xl bg-amber-500/10">
              <DollarSign className="h-6 w-6 text-amber-600" />
            </div>
          </div>
        </GlowCard>
      </CardContent>
    </Card>
  );
}
