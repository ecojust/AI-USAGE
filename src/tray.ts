export type MenuBarQuotaDisplay = {
  plan: string;
  fiveHour: string;
  fiveHourTimeUntilReset: number | null;
  sevenDay: string;
  sevenDayTimeUntilReset: number | null;
  sevenDayIsFinalDay: boolean;
  refreshPulse: number | null;
  template:
    | "concentrated"
    | "text"
    | "quota"
    | "stacked"
    | "labeled"
    | "rings"
    | "capsule"
    | "meter"
    | "dial"
    | "location";
  stale: boolean;
};

// macOS tray images are displayed at 18 pt high. Render at 3× for crisp small
// text on Retina screens.
export function renderMenuBarQuota(display: MenuBarQuotaDisplay) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法绘制菜单栏额度");
  const font = '-apple-system, BlinkMacSystemFont, sans-serif';
  const plan = display.plan;
  const hasPlan = !["quota", "labeled"].includes(display.template);
  context.font = `600 12px ${font}`;
  let displayedPlan = plan;
  if (display.template === "location") {
    const maxPlanWidth = 78;
    while (displayedPlan && context.measureText(displayedPlan).width > maxPlanWidth) {
      const characters = Array.from(displayedPlan);
      displayedPlan = `${characters.slice(0, -2).join("")}…`;
    }
  }
  const planWidth = displayedPlan && hasPlan
    ? Math.ceil(context.measureText(displayedPlan).width) + 7
    : 0;
  const fiveHourValue = display.fiveHour;
  const sevenDayValue = display.sevenDay;
  const rows = [
    [fiveHourValue, 5, display.fiveHourTimeUntilReset, 4.5],
    [sevenDayValue, 7, display.sevenDayTimeUntilReset, 13.5],
  ] as const;
  context.font = `600 9px ${font}`;
  const valueWidth = Math.ceil(Math.max(
    context.measureText(fiveHourValue).width,
    context.measureText(sevenDayValue).width,
  ));
  const barWidth = display.template === "quota" ? 52 : display.template === "labeled" ? 34 : 35;
  const barGap = 1.25;
  const barValueGap = 5;
  const barX = planWidth + 1;
  context.font = `500 9px ${font}`;
  const compactLabelWidth = context.measureText("5h ").width
    + context.measureText("   ").width + context.measureText("7d ").width;
  context.font = `600 9px ${font}`;
  const compactValueWidth = context.measureText(fiveHourValue).width + context.measureText(sevenDayValue).width;
  context.font = `500 8px ${font}`;
  const stackedLabelWidth = Math.ceil(Math.max(context.measureText("5h").width, context.measureText("7d").width)) + 4;
  const periodLabelWidth = Math.ceil(Math.max(context.measureText("5h").width, context.measureText("7d").width)) + 4;
  const ringWidth = 8;
  const contentWidth = display.template === "dial"
    ? planWidth + 16 + barValueGap + valueWidth + 2
    : display.template === "capsule"
      ? planWidth + 35 + barValueGap + valueWidth + 2
      : display.template === "meter"
        ? planWidth + 35 + barValueGap + valueWidth + 2
    : display.template === "text"
    ? planWidth + Math.ceil(compactLabelWidth + compactValueWidth) + 2
    : display.template === "stacked"
      ? planWidth + stackedLabelWidth + valueWidth + 2
      : display.template === "rings"
        ? planWidth + ringWidth + barValueGap + valueWidth + 2
        : (display.template === "quota" ? 1 : display.template === "labeled" ? periodLabelWidth : barX) + barWidth + barValueGap + valueWidth + 2;
  const horizontalPadding = 6;
  const width = contentWidth + horizontalPadding * 2;
  const height = 18;
  const scale = 3;
  canvas.width = width * scale;
  canvas.height = height * scale;
  context.scale(scale, scale);
  if (display.refreshPulse != null) {
    const pulse = Math.sin(Math.PI * display.refreshPulse) ** 2;
    context.globalAlpha = 1 - pulse * 0.3;
  }

  // Template images use black pixels and alpha only; macOS applies a
  // contrasting foreground for the current menu bar appearance.
  const foreground = "black";
  const contentX = horizontalPadding;
  const contentRight = width - horizontalPadding;
  const drawValue = (value: string, x: number, y: number, align: CanvasTextAlign = "left") => {
    context.font = `600 9px ${font}`;
    context.textAlign = align;
    context.fillStyle = foreground;
    context.fillText(value, x, y);
    return Math.ceil(context.measureText(value).width);
  };

  context.fillStyle = foreground;
  context.textBaseline = "middle";
  context.font = `600 12px ${font}`;
  if (hasPlan) {
    context.fillText(displayedPlan, contentX, 9);
  }

  if (display.template === "text") {
    let x = contentX + planWidth;
    context.font = `500 9px ${font}`;
    context.textAlign = "left";
    context.fillText("5h", x, 9);
    x += context.measureText("5h ").width;
    x += drawValue(fiveHourValue, x, 9);
    context.font = `500 9px ${font}`;
    x += context.measureText("   ").width;
    context.fillStyle = foreground;
    context.fillText("7d", x, 9);
    x += context.measureText("7d ").width;
    drawValue(sevenDayValue, x, 9);
  } else if (display.template === "stacked") {
    for (const [rowIndex, row] of rows.entries()) {
      const [value, , , y] = row;
      context.font = `500 8px ${font}`;
      context.textAlign = "left";
      context.fillStyle = "#aab2ac";
      context.fillText(rowIndex === 0 ? "5h" : "7d", contentX + planWidth, y);
      drawValue(value, contentRight - 1, y, "right");
    }
  } else if (display.template === "rings") {
    const radius = 2.6;
    const ringX = contentX + planWidth + 1;
    context.lineWidth = 0.9;
    context.lineCap = "round";
    for (const [rowIndex, row] of rows.entries()) {
      const [, segmentCount, timeUntilReset, y] = row;
      const segmentAngle = Math.PI * 2 / segmentCount;
      const sweep = segmentAngle * 0.68;
      const filledSegments = timeUntilReset == null ? 0 : timeUntilReset / 100 * segmentCount;
      for (let index = 0; index < segmentCount; index += 1) {
        const start = -Math.PI / 2 + index * segmentAngle;
        const fraction = Math.max(0, Math.min(1, filledSegments - index));
        context.strokeStyle = "rgba(0, 0, 0, 0.22)";
        context.beginPath();
        context.arc(ringX + radius, y, radius, start, start + sweep);
        context.stroke();
        if (fraction > 0) {
          context.strokeStyle = foreground;
          context.beginPath();
          context.arc(ringX + radius, y, radius, start, start + sweep * fraction);
          context.stroke();
        }
      }
      const value = rowIndex === 0 ? fiveHourValue : sevenDayValue;
      drawValue(value, contentRight - 1, y, "right");
    }
  } else if (display.template === "capsule") {
    const trackX = contentX + planWidth + 1;
    const trackWidth = 35;
    const trackHeight = 4;
    for (const [index, row] of rows.entries()) {
      const [, , timeUntilReset, y] = row;
      const trackY = y - trackHeight / 2;
      const progress = timeUntilReset == null ? 0 : timeUntilReset / 100;
      context.fillStyle = "rgba(0, 0, 0, 0.22)";
      context.beginPath();
      context.roundRect(trackX, trackY, trackWidth, trackHeight, trackHeight / 2);
      context.fill();
      if (progress > 0) {
        context.fillStyle = foreground;
        context.beginPath();
        context.roundRect(trackX, trackY, trackWidth * progress, trackHeight, trackHeight / 2);
        context.fill();
      }
      if (index === 0) {
        context.fillStyle = "rgba(0, 0, 0, 0.42)";
        context.beginPath();
        context.arc(trackX + trackWidth + 2, y, 1.2, 0, Math.PI * 2);
        context.fill();
      }
      drawValue(row[0], contentRight - 1, y, "right");
    }
  } else if (display.template === "meter") {
    const rulerX = contentX + planWidth + 1;
    const rulerWidth = 35;
    for (const [rowIndex, row] of rows.entries()) {
      const [, segmentCount, timeUntilReset, y] = row;
      const progress = timeUntilReset == null ? 0 : timeUntilReset / 100;
      if (rowIndex === 1 && display.sevenDayIsFinalDay) {
        context.fillStyle = "rgba(0, 0, 0, 0.24)";
        context.fillRect(rulerX, y - 2, rulerWidth, 4);
        if (progress > 0) {
          context.fillStyle = foreground;
          context.fillRect(rulerX, y - 2, rulerWidth * progress, 4);
        }
        drawValue(row[0], contentRight - 1, y, "right");
        continue;
      }
      const gap = 1.1;
      const tickWidth = (rulerWidth - (segmentCount - 1) * gap) / segmentCount;
      const filledTicks = progress * segmentCount;
      for (let tick = 0; tick < segmentCount; tick += 1) {
        const tickX = rulerX + tick * (tickWidth + gap);
        const fraction = Math.max(0, Math.min(1, filledTicks - tick));
        context.fillStyle = "rgba(0, 0, 0, 0.24)";
        context.fillRect(tickX, y - 2, tickWidth, 4);
        if (fraction > 0) {
          context.fillStyle = foreground;
          context.fillRect(tickX, y - 2, tickWidth * fraction, 4);
        }
      }
      drawValue(row[0], contentRight - 1, y, "right");
      if (rowIndex === 0) continue;
    }
  } else if (display.template === "dial") {
    const centerX = contentX + planWidth + 5;
    const centerY = 9;
    const radius = 6;
    const primaryProgress = display.fiveHourTimeUntilReset;
    const secondaryProgress = display.sevenDayTimeUntilReset;
    context.lineWidth = 1.5;
    context.lineCap = "round";
    for (const [offset, progress] of [[0, primaryProgress], [10, secondaryProgress]] as const) {
      context.strokeStyle = "rgba(0, 0, 0, 0.22)";
      context.beginPath();
      context.arc(centerX + offset, centerY, radius, -Math.PI * 0.82, Math.PI * 0.82);
      context.stroke();
      if (progress != null) {
        context.strokeStyle = foreground;
        context.beginPath();
        context.arc(centerX + offset, centerY, radius, -Math.PI * 0.82, -Math.PI * 0.82 + Math.PI * 1.64 * progress / 100);
        context.stroke();
      }
    }
    drawValue(fiveHourValue, contentRight - 1, 9, "right");
  } else {
    const labeled = display.template === "labeled";
    const segmentBarX = display.template === "quota" ? contentX + 1 : labeled ? contentX + periodLabelWidth : contentX + barX;
    for (const [rowIndex, row] of rows.entries()) {
      const [value, segmentCount, timeUntilReset, y] = row;
      const finalDay = rowIndex === 1 && display.sevenDayIsFinalDay;
      if (labeled) {
        context.font = `500 8px ${font}`;
        context.textAlign = "left";
        context.fillStyle = foreground;
        context.fillText(rowIndex === 0 ? "5h" : "7d", contentX, y);
      }
      const segmentWidth = (barWidth - (segmentCount - 1) * barGap) / segmentCount;
      const barY = y - 1.6;
      const progress = timeUntilReset == null ? 0 : timeUntilReset / 100;
      if (finalDay) {
        context.fillStyle = "rgba(0, 0, 0, 0.22)";
        context.beginPath();
        context.roundRect(segmentBarX, barY, barWidth, 3.2, 1.6);
        context.fill();
        if (progress > 0) {
          context.fillStyle = foreground;
          context.beginPath();
          context.roundRect(segmentBarX, barY, barWidth * progress, 3.2, 1.6);
          context.fill();
        }
      } else {
        const filledSegments = progress * segmentCount;
        for (let index = 0; index < segmentCount; index += 1) {
          const segmentX = segmentBarX + index * (segmentWidth + barGap);
          context.fillStyle = "rgba(0, 0, 0, 0.22)";
          context.beginPath();
          context.roundRect(segmentX, barY, segmentWidth, 3.2, 1.6);
          context.fill();
          const fraction = Math.max(0, Math.min(1, filledSegments - index));
          if (fraction > 0) {
            context.fillStyle = foreground;
            context.beginPath();
            context.roundRect(segmentX, barY, segmentWidth * fraction, 3.2, 1.6);
            context.fill();
          }
        }
      }
      drawValue(value, contentRight - 1, y, "right");
    }
  }
  return {
    title: `${display.plan ? `${display.plan} · ` : ""}5小时用量剩余 ${display.fiveHour}，5h × ${display.fiveHourTimeUntilReset == null ? "未知" : `${display.fiveHourTimeUntilReset.toFixed(0)}%`} · 本周剩余 ${display.sevenDay}，7d × ${display.sevenDayTimeUntilReset == null ? "未知" : `${display.sevenDayTimeUntilReset.toFixed(0)}%`}（7天额度周期）${display.stale ? "（刷新失败）" : ""}`,
    rgba: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
    width: canvas.width,
    height: canvas.height,
  };
}
