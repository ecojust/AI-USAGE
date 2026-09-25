<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { renderMenuBarQuota } from "./tray";
import {
  type AccountQuotaSnapshot,
  type QuotaWindow,
  formatPercent,
  getRemainingPercent,
} from "./quota";

type TrayTemplate =
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
const TRAY_TEMPLATE_STORAGE_KEY = "ai-usage-tray-template";
function storedTemplate(): TrayTemplate {
  try {
    const stored = localStorage.getItem(TRAY_TEMPLATE_STORAGE_KEY);
    return stored === "text" ||
      stored === "quota" ||
      stored === "stacked" ||
      stored === "labeled" ||
      stored === "rings" ||
      stored === "capsule" ||
      stored === "meter" ||
      stored === "dial" ||
      stored === "location"
      ? stored
      : "concentrated";
  } catch {
    return "concentrated";
  }
}

const accountQuota = ref<AccountQuotaSnapshot | null>(null);
const requestLocation = ref("定位中");
const error = ref<string | null>(null);
const clock = ref(Date.now());
const selectedTemplate = ref<TrayTemplate>(storedTemplate());
const settingsShell = ref<HTMLElement | null>(null);
let fetching = false;
let disposed = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let locationTimer: ReturnType<typeof setInterval> | undefined;
let resizeObserver: ResizeObserver | undefined;

async function refresh() {
  if (fetching || disposed) return;
  fetching = true;
  try {
    const result = await invoke<AccountQuotaSnapshot>("get_usage");
    if (disposed) return;
    accountQuota.value = result;
    error.value = null;
  } catch (cause) {
    if (!disposed) error.value = String(cause);
  } finally {
    fetching = false;
  }
}

async function refreshRequestLocation() {
  try {
    const response = await fetch("https://ipwho.is/?lang=zh-CN");
    if (!response.ok) throw new Error("location lookup failed");
    const result = (await response.json()) as {
      success?: boolean;
      region?: string;
      country?: string;
    };
    if (!result.success) throw new Error("location lookup failed");
    const country = result.country?.trim() ?? "";
    let region = result.region?.trim() ?? "";
    if (country === "中国") region = region.replace(/市$/, "");
    if (country === "美国" && region && !/(州|特区)$/.test(region)) {
      region += "州";
    }
    requestLocation.value = [country, region]
      .filter((part, index, parts) => part && parts.indexOf(part) === index)
      .join(" ") || "未知地点";
  } catch {
    requestLocation.value = "地点不可用";
  }
}

const activeQuotaWindows = computed(() =>
  (accountQuota.value?.buckets ?? [])
    .flatMap((bucket) => [bucket.primary, bucket.secondary])
    .filter(
      (window): window is QuotaWindow =>
        window !== null &&
        (window.resetsAt === null || window.resetsAt * 1000 > clock.value),
    ),
);
const planLabel = computed(
  () =>
    accountQuota.value?.buckets
      .find((bucket) => bucket.planType)
      ?.planType?.trim()
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) ?? "",
);
const trayDisplay = computed(() => {
  const fiveHourWindow = activeQuotaWindows.value.find(
    (window) => window.windowDurationMins === 300,
  );
  const sevenDayWindow = activeQuotaWindows.value.find(
    (window) => window.windowDurationMins === 10080,
  );
  const getResetProgress = (window: QuotaWindow | undefined) => {
    if (window?.resetsAt == null || window.windowDurationMins == null) return null;

    const windowDurationMs = window.windowDurationMins * 60 * 1000;
    const remainingTimeMs = window.resetsAt * 1000 - clock.value;
    const oneDayMs = 24 * 60 * 60 * 1000;
    const progressDurationMs =
      window.windowDurationMins === 10080 && remainingTimeMs < oneDayMs
        ? oneDayMs
        : windowDurationMs;
    return Math.max(0, Math.min(100, (remainingTimeMs / progressDurationMs) * 100));
  };

  return {
    plan: selectedTemplate.value === "location" ? requestLocation.value : planLabel.value,
    fiveHour: formatPercent(
      fiveHourWindow ? getRemainingPercent(fiveHourWindow) : null,
    ),
    fiveHourTimeUntilReset: getResetProgress(fiveHourWindow),
    sevenDay: formatPercent(
      sevenDayWindow ? getRemainingPercent(sevenDayWindow) : null,
    ),
    sevenDayTimeUntilReset: getResetProgress(sevenDayWindow),
    sevenDayIsFinalDay: Boolean(
      sevenDayWindow?.resetsAt != null &&
        sevenDayWindow.resetsAt * 1000 - clock.value < 24 * 60 * 60 * 1000,
    ),
    template: selectedTemplate.value,
    stale: Boolean(error.value),
  };
});
watch(
  trayDisplay,
  (value) => {
    void invoke("set_tray_display", renderMenuBarQuota(value)).catch(() => undefined);
  },
  { immediate: true },
);

function chooseTemplate(template: TrayTemplate) {
  selectedTemplate.value = template;
  try {
    localStorage.setItem(TRAY_TEMPLATE_STORAGE_KEY, template);
  } catch {
    // Keep the selected template in memory when storage is unavailable.
  }
}

async function fitWindowToContent() {
  await nextTick();
  const contentHeight = settingsShell.value?.getBoundingClientRect().height;
  if (contentHeight == null) return;

  // Measure the entire shell so the footer QR code is included as well.
  await invoke("fit_settings_window", {
    contentHeight: Math.ceil(contentHeight),
  });
}

onMounted(() => {
  void refresh();
  void refreshRequestLocation();
  refreshTimer = setInterval(() => void refresh(), 30 * 1000);
  locationTimer = setInterval(() => void refreshRequestLocation(), 10 * 60 * 1000);
  clockTimer = setInterval(() => {
    clock.value = Date.now();
  }, 15000);
  if (settingsShell.value) {
    resizeObserver = new ResizeObserver(() => void fitWindowToContent());
    resizeObserver.observe(settingsShell.value);
    void fitWindowToContent();
  }
});
onUnmounted(() => {
  disposed = true;
  clearInterval(refreshTimer);
  clearInterval(clockTimer);
  clearInterval(locationTimer);
  resizeObserver?.disconnect();
});
</script>

<template>
  <main ref="settingsShell" class="settings-shell">
    <section class="template-picker" role="radiogroup" aria-label="菜单栏额度显示模板">
      <button
        class="template-option"
        :class="{ selected: selectedTemplate === 'concentrated' }"
        role="radio"
        :aria-checked="selectedTemplate === 'concentrated'"
        @click="chooseTemplate('concentrated')"
      >
        <div class="preview preview-concentrated">
          <span class="preview-plan">Plus</span>
          <div class="preview-bars">
            <i class="bars"><b v-for="n in 5" :key="n" :class="{ filled: n < 5 }" /></i>
            <i class="bars"><b v-for="n in 7" :key="n" :class="{ filled: n < 6 }" /></i>
          </div>
          <div class="preview-values"><strong>73%</strong><strong>81%</strong></div>
        </div>
        <span class="option-copy"
          ><span class="option-title">集中显示</span
          ><span class="option-description">套餐名、周期条和剩余数值</span></span
        >
      </button>

      <button
        class="template-option"
        :class="{ selected: selectedTemplate === 'location' }"
        role="radio"
        :aria-checked="selectedTemplate === 'location'"
        @click="chooseTemplate('location')"
      >
        <div class="preview preview-location">
          <span class="preview-plan">东京 日本</span>
          <div class="preview-bars">
            <i class="bars"><b v-for="n in 5" :key="n" :class="{ filled: n < 5 }" /></i>
            <i class="bars"><b v-for="n in 7" :key="n" :class="{ filled: n < 6 }" /></i>
          </div>
          <div class="preview-values"><strong>73%</strong><strong>81%</strong></div>
        </div>
        <span class="option-copy"
          ><span class="option-title">请求地点</span
          ><span class="option-description">显示当前公网出口 IP 的估算地点</span></span
        >
      </button>

      <!-- <button class="template-option" :class="{ selected: selectedTemplate === 'text' }" role="radio" :aria-checked="selectedTemplate === 'text'" @click="chooseTemplate('text')">
        <div class="preview preview-text"><span class="preview-plan">Plus</span><span>5h <strong>73%</strong></span><span>7d <strong>81%</strong></span></div>
        <span class="option-copy"><span class="option-title">紧凑文字</span><span class="option-description">套餐名和两个周期的剩余数值</span></span>
      </button> -->

      <button
        class="template-option"
        :class="{ selected: selectedTemplate === 'quota' }"
        role="radio"
        :aria-checked="selectedTemplate === 'quota'"
        @click="chooseTemplate('quota')"
      >
        <div class="preview preview-quota">
          <div class="preview-bars">
            <i class="bars"><b v-for="n in 5" :key="n" :class="{ filled: n < 5 }" /></i>
            <i class="bars"><b v-for="n in 7" :key="n" :class="{ filled: n < 6 }" /></i>
          </div>
          <div class="preview-values"><strong>73%</strong><strong>81%</strong></div>
        </div>
        <span class="option-copy"
          ><span class="option-title">纯额度条</span
          ><span class="option-description">隐藏套餐名，突出周期进度和余量</span></span
        >
      </button>

      <button
        class="template-option"
        :class="{ selected: selectedTemplate === 'stacked' }"
        role="radio"
        :aria-checked="selectedTemplate === 'stacked'"
        @click="chooseTemplate('stacked')"
      >
        <div class="preview preview-stacked">
          <span class="preview-plan">Plus</span>
          <span class="stacked-values"
            ><i>5h <strong>73%</strong></i
            ><i>7d <strong>81%</strong></i></span
          >
        </div>
        <span class="option-copy"
          ><span class="option-title">套餐名＋双行数值</span
          ><span class="option-description">无进度条，直接显示两个周期余量</span></span
        >
      </button>

      <button
        class="template-option"
        :class="{ selected: selectedTemplate === 'labeled' }"
        role="radio"
        :aria-checked="selectedTemplate === 'labeled'"
        @click="chooseTemplate('labeled')"
      >
        <div class="preview preview-labeled">
          <span class="preview-periods"><i>5h</i><i>7d</i></span>
          <div class="preview-bars">
            <i class="bars"><b v-for="n in 5" :key="n" :class="{ filled: n < 5 }" /></i>
            <i class="bars"><b v-for="n in 7" :key="n" :class="{ filled: n < 6 }" /></i>
          </div>
          <div class="preview-values"><strong>73%</strong><strong>81%</strong></div>
        </div>
        <span class="option-copy"
          ><span class="option-title">周期标签＋分段条</span
          ><span class="option-description"
            >标明 5 小时和 7 天周期，隐藏套餐名</span
          ></span
        >
      </button>

      <!-- <button
        class="template-option"
        :class="{ selected: selectedTemplate === 'rings' }"
        role="radio"
        :aria-checked="selectedTemplate === 'rings'"
        @click="chooseTemplate('rings')"
      >
        <div class="preview preview-rings">
          <span class="preview-plan">Plus</span>
          <svg viewBox="0 0 30 24" aria-hidden="true">
            <circle cx="7" cy="12" r="5" class="ring-track ring-five" />
            <circle cx="22" cy="12" r="5" class="ring-track ring-seven" />
          </svg>
          <div class="preview-values"><strong>73%</strong><strong>81%</strong></div>
        </div>
        <span class="option-copy"
          ><span class="option-title">圆弧倒计时</span
          ><span class="option-description">5 段与 7 段圆弧显示重置进度</span></span
        >
      </button> -->

      <!-- 
      <button
        class="template-option"
        :class="{ selected: selectedTemplate === 'capsule' }"
        role="radio"
        :aria-checked="selectedTemplate === 'capsule'"
        @click="chooseTemplate('capsule')"
      >
        <div class="preview preview-capsule">
          <span class="preview-plan">Plus</span>
          <div class="capsule-preview-track"><i /><i /></div>
          <div class="preview-values"><strong>73%</strong><strong>81%</strong></div>
        </div>
        <span class="option-copy"
          ><span class="option-title">双芯胶囊</span
          ><span class="option-description"
            >两枚余量胶囊，直观对比短期与周额度</span
          ></span
        >
      </button> -->

      <button
        class="template-option"
        :class="{ selected: selectedTemplate === 'meter' }"
        role="radio"
        :aria-checked="selectedTemplate === 'meter'"
        @click="chooseTemplate('meter')"
      >
        <div class="preview preview-meter">
          <span class="preview-plan">Plus</span>
          <div class="meter-preview">
            <i v-for="n in 5" :key="`five-${n}`" :class="{ on: n <= 4 }" /><span />
            <i v-for="n in 7" :key="`seven-${n}`" :class="{ on: n <= 6 }" />
          </div>
          <div class="preview-values"><strong>73%</strong><strong>81%</strong></div>
        </div>
        <span class="option-copy"
          ><span class="option-title">刻度电量尺</span
          ><span class="option-description"
            >竖向刻度像电量表一样呈现剩余进度</span
          ></span
        >
      </button>

      <!-- <button
        class="template-option"
        :class="{ selected: selectedTemplate === 'dial' }"
        role="radio"
        :aria-checked="selectedTemplate === 'dial'"
        @click="chooseTemplate('dial')"
      >
        <div class="preview preview-dial">
          <span class="preview-plan">Plus</span>
          <svg viewBox="0 0 34 24" aria-hidden="true">
            <circle cx="9" cy="12" r="7" class="dial-track" />
            <circle cx="25" cy="12" r="7" class="dial-track dial-secondary" />
          </svg>
          <strong class="dial-value">73%</strong>
        </div>
        <span class="option-copy"
          ><span class="option-title">双环仪表</span
          ><span class="option-description"
            >两个环形周期围绕一个醒目的主余量</span
          ></span
        >
      </button> -->
    </section>
  </main>
</template>
