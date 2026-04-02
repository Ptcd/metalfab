interface ScoreBadgeProps {
  score: number;
  greenThreshold?: number;
  yellowThreshold?: number;
}

export function ScoreBadge({ score, greenThreshold = 70, yellowThreshold = 40 }: ScoreBadgeProps) {
  let bg: string;
  let text: string;

  if (score >= greenThreshold) {
    bg = "bg-emerald-100 dark:bg-emerald-900/40";
    text = "text-emerald-700 dark:text-emerald-300";
  } else if (score >= yellowThreshold) {
    bg = "bg-amber-100 dark:bg-amber-900/40";
    text = "text-amber-700 dark:text-amber-300";
  } else {
    bg = "bg-red-100 dark:bg-red-900/40";
    text = "text-red-700 dark:text-red-300";
  }

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${bg} ${text}`}>
      {score}
    </span>
  );
}
