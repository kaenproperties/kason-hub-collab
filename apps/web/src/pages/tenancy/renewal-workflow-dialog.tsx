import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CheckCircle2, PhoneCall } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { TenancyListItem } from "./tenancies-table";

export function daysUntilTenancyEnd(endDate: string | null, now = new Date()): number | null {
  if (!endDate) return null;
  const end = new Date(`${endDate.slice(0, 10)}T00:00:00`);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.ceil((end.getTime() - today.getTime()) / 86_400_000);
}

function addDays(date: string, days: number) {
  const value = new Date(`${date.slice(0, 10)}T00:00:00`);
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}

function oneYearLessOneDay(startDate: string) {
  const value = new Date(`${startDate}T00:00:00`);
  value.setFullYear(value.getFullYear() + 1);
  value.setDate(value.getDate() - 1);
  return value.toISOString().slice(0, 10);
}

export function RenewalWorkflowDialog({
  tenancy,
  open,
  onOpenChange,
}: {
  tenancy: TenancyListItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<"pending" | "contacted" | "renew" | "not_renew">("pending");
  const [notes, setNotes] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [rent, setRent] = useState("");
  const [fee, setFee] = useState("0.00");
  const [feeDueDate, setFeeDueDate] = useState("");
  const [message, setMessage] = useState("");
  const [reviewSaved, setReviewSaved] = useState(false);

  useEffect(() => {
    if (!tenancy) return;
    const start = tenancy.endDate ? addDays(tenancy.endDate, 1) : "";
    setDecision(tenancy.renewalDecision ?? "pending");
    setNotes(tenancy.renewalNotes ?? "");
    setNewCode(`${tenancy.tenancyCode}-R`);
    setNewStart(start);
    setNewEnd(start ? oneYearLessOneDay(start) : "");
    setRent(tenancy.monthlyRentAmount.toFixed(2));
    setFee(tenancy.renewalFeeCharge?.amount.toFixed(2) ?? "0.00");
    setFeeDueDate(start);
    setMessage("");
    setReviewSaved(tenancy.renewalDecision === "renew");
  }, [tenancy]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["tenancy"] }),
      queryClient.invalidateQueries({ queryKey: ["action-centre"] }),
      queryClient.invalidateQueries({ queryKey: ["bills-grid"] }),
    ]);
  };

  const review = useMutation({
    mutationFn: () => apiFetch(`/tenancy/tenancies/${tenancy!.id}/renewal-review`, {
      method: "PUT",
      body: JSON.stringify({ decision, notes }),
    }),
    onSuccess: async () => {
      setReviewSaved(decision === "renew");
      setMessage(decision === "renew" ? "Renewal decision saved. Complete the renewed terms below." : "Follow-up saved.");
      await refresh();
    },
    onError: (error: Error) => setMessage(error.message),
  });

  const renew = useMutation({
    mutationFn: () => apiFetch(`/tenancy/tenancies/${tenancy!.id}/renew`, {
      method: "POST",
      body: JSON.stringify({
        newTenancyCode: newCode,
        newStartDate: newStart,
        newEndDate: newEnd || undefined,
        monthlyRentAmount: rent,
        renewalFeeAmount: fee,
        renewalFeeDueDate: feeDueDate || undefined,
      }),
    }),
    onSuccess: async () => {
      setMessage("Renewed tenancy created. Any TA fee entered is now Saved · not billed in Tenant & Owner Billing.");
      await refresh();
    },
    onError: (error: Error) => setMessage(error.message),
  });

  const daysLeft = useMemo(() => daysUntilTenancyEnd(tenancy?.endDate ?? null), [tenancy?.endDate]);
  if (!tenancy) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-2xl"><CalendarClock className="h-6 w-6 text-[var(--gold)]" />Renewal action · {tenancy.propertyName} {tenancy.unitCode}</DialogTitle>
          <DialogDescription className="text-base">
            {tenancy.tenantName} · tenancy ends {tenancy.endDate?.slice(0, 10) ?? "without an end date"}
            {daysLeft != null ? ` · ${daysLeft >= 0 ? `${daysLeft} days remaining` : `${Math.abs(daysLeft)} days overdue`}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 lg:grid-cols-2">
          <section className="rounded-xl border border-amber-300 bg-amber-50 p-5">
            <h3 className="flex items-center gap-2 text-lg font-bold text-[var(--navy)]"><PhoneCall className="h-5 w-5" />Step 1 · Ask the tenant</h3>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">Operation Admin records the contact result here. This clears or advances the 60-day reminder.</p>
            <label className="mt-4 block text-sm font-semibold">Tenant response</label>
            <select className="mt-1 h-11 w-full rounded-lg border border-[var(--border)] bg-white px-3" value={decision} onChange={(event) => { setDecision(event.target.value as typeof decision); setReviewSaved(false); }}>
              <option value="pending">Not contacted yet</option>
              <option value="contacted">Contacted · waiting for answer</option>
              <option value="renew">Tenant wants to renew</option>
              <option value="not_renew">Tenant will not renew</option>
            </select>
            <label className="mt-4 block text-sm font-semibold">Follow-up notes</label>
            <textarea className="mt-1 min-h-28 w-full rounded-lg border border-[var(--border)] bg-white p-3" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Contact date, WhatsApp/call, agreed terms or next follow-up…" />
            <Button className="mt-4 w-full" variant="gold" onClick={() => review.mutate()} disabled={review.isPending}>{review.isPending ? "Saving…" : "Save tenant response"}</Button>
          </section>

          <section className={`rounded-xl border p-5 ${decision === "renew" && reviewSaved ? "border-emerald-300 bg-emerald-50" : "border-[var(--border)] bg-[var(--page-bg)] opacity-70"}`}>
            <h3 className="flex items-center gap-2 text-lg font-bold text-[var(--navy)]"><CheckCircle2 className="h-5 w-5" />Step 2 · Create renewed tenancy</h3>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">Available after “Tenant wants to renew” is saved. Enter the final SST-inclusive amount to create the renewal TA charge.</p>
            <fieldset disabled={decision !== "renew" || !reviewSaved || renew.isPending} className="mt-4 grid gap-3 disabled:opacity-60">
              <label className="text-sm font-semibold">New tenancy code<Input className="mt-1" value={newCode} onChange={(event) => setNewCode(event.target.value)} /></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm font-semibold">New start<Input className="mt-1" type="date" value={newStart} onChange={(event) => { const start = event.target.value; setNewStart(start); if (start) setNewEnd(oneYearLessOneDay(start)); }} /></label>
                <label className="text-sm font-semibold">New end<Input className="mt-1" type="date" value={newEnd} onChange={(event) => setNewEnd(event.target.value)} /></label>
              </div>
              <label className="text-sm font-semibold">New monthly rent (RM)<Input className="mt-1" type="number" min="0.01" step="0.01" value={rent} onChange={(event) => setRent(event.target.value)} /></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm font-semibold">Renewal TA (WITH SST) amount (RM)<Input className="mt-1" type="number" min="0" step="0.01" value={fee} onChange={(event) => setFee(event.target.value)} /></label>
                <label className="text-sm font-semibold">TA fee due date<Input className="mt-1" type="date" value={feeDueDate} onChange={(event) => setFeeDueDate(event.target.value)} /></label>
              </div>
              <Button className="mt-1 w-full" onClick={() => renew.mutate()} disabled={!newCode || !newStart || !rent || renew.isPending}>{renew.isPending ? "Creating renewal…" : "Create renewal & TA fee"}</Button>
            </fieldset>
          </section>
        </div>

        {message && <div className={`mt-4 rounded-lg border px-4 py-3 font-semibold ${message.includes("created") || message.includes("saved") ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-red-300 bg-red-50 text-red-800"}`}>{message}</div>}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
