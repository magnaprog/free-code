import { c as _c } from "react/compiler-runtime";
import capitalize from 'lodash-es/capitalize.js';
import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { FAST_MODE_MODEL_DISPLAY, isFastModeAvailable, isFastModeCooldown, isFastModeEnabled } from 'src/utils/fastMode.js';
import { Box, Text } from '../ink.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import { convertEffortValueToLevel, type EffortLevel, getDefaultEffortForModel, modelSupportsEffort, modelSupportsMaxEffort, modelSupportsXHighEffort, resolvePickerEffortPersistence, toPersistableEffort } from '../utils/effort.js';
import { getDefaultMainLoopModel, type ModelSetting, modelDisplayString, parseUserSpecifiedModel } from '../utils/model/model.js';
import { getModelOptions } from '../utils/model/modelOptions.js';
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select } from './CustomSelect/index.js';
import { Byline } from './design-system/Byline.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { Pane } from './design-system/Pane.js';
import { effortLevelToSymbol } from './EffortIndicator.js';
export type Props = {
  initial: string | null;
  sessionModel?: ModelSetting;
  onSelect: (model: string | null, effort: EffortLevel | undefined) => void;
  onCancel?: () => void;
  isStandaloneCommand?: boolean;
  showFastModeNotice?: boolean;
  /** Overrides the dim header line below "Select model". */
  headerText?: string;
  /**
   * When true, skip writing effortLevel to userSettings on selection.
   * Used by the assistant installer wizard where the model choice is
   * project-scoped (written to the assistant's .claude/settings.json via
   * install.ts) and should not leak to the user's global ~/.claude/settings.
   */
  skipSettingsWrite?: boolean;
};
const NO_PREFERENCE = '__NO_PREFERENCE__';
export function ModelPicker(t0) {
  const $ = _c(82);
  const {
    initial,
    sessionModel,
    onSelect,
    onCancel,
    isStandaloneCommand,
    showFastModeNotice,
    headerText,
    skipSettingsWrite
  } = t0;
  const setAppState = useSetAppState();
  const exitState = useExitOnCtrlCDWithKeybindings();
  const initialValue = initial === null ? NO_PREFERENCE : initial;
  const [focusedValue, setFocusedValue] = useState(initialValue);
  const isFastMode = useAppState(_temp);
  const [hasToggledEffort, setHasToggledEffort] = useState(false);
  const effortValue = useAppState(_temp2);
  let t1;
  if ($[0] !== effortValue) {
    t1 = effortValue !== undefined ? convertEffortValueToLevel(effortValue) : undefined;
    $[0] = effortValue;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const [effort, setEffort] = useState(t1);
  const t2 = isFastMode ?? false;
  let t3;
  if ($[2] !== t2) {
    t3 = getModelOptions(t2);
    $[2] = t2;
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  const modelOptions = t3;
  let t4;
  bb0: {
    if (initial !== null && !modelOptions.some(opt => opt.value === initial)) {
      let t5;
      if ($[4] !== initial) {
        t5 = modelDisplayString(initial);
        $[4] = initial;
        $[5] = t5;
      } else {
        t5 = $[5];
      }
      let t6;
      if ($[6] !== initial || $[7] !== t5) {
        t6 = {
          value: initial,
          label: t5,
          description: "Current model"
        };
        $[6] = initial;
        $[7] = t5;
        $[8] = t6;
      } else {
        t6 = $[8];
      }
      let t7;
      if ($[9] !== modelOptions || $[10] !== t6) {
        t7 = [...modelOptions, t6];
        $[9] = modelOptions;
        $[10] = t6;
        $[11] = t7;
      } else {
        t7 = $[11];
      }
      t4 = t7;
      break bb0;
    }
    t4 = modelOptions;
  }
  const optionsWithInitial = t4;
  let t5;
  if ($[12] !== optionsWithInitial) {
    t5 = optionsWithInitial.map(_temp3);
    $[12] = optionsWithInitial;
    $[13] = t5;
  } else {
    t5 = $[13];
  }
  const selectOptions = t5;
  let t6;
  if ($[14] !== initialValue || $[15] !== selectOptions) {
    t6 = selectOptions.some(_ => _.value === initialValue) ? initialValue : selectOptions[0]?.value ?? undefined;
    $[14] = initialValue;
    $[15] = selectOptions;
    $[16] = t6;
  } else {
    t6 = $[16];
  }
  const initialFocusValue = t6;
  const visibleCount = Math.min(10, selectOptions.length);
  const hiddenCount = Math.max(0, selectOptions.length - visibleCount);
  let t7;
  if ($[17] !== focusedValue || $[18] !== selectOptions) {
    t7 = selectOptions.find(opt_1 => opt_1.value === focusedValue)?.label;
    $[17] = focusedValue;
    $[18] = selectOptions;
    $[19] = t7;
  } else {
    t7 = $[19];
  }
  const focusedModelName = t7;
  let focusedSupportsEffort;
  let t8;
  if ($[20] !== focusedValue) {
    const focusedModel = resolveOptionModel(focusedValue);
    focusedSupportsEffort = focusedModel ? modelSupportsEffort(focusedModel) : false;
    t8 = focusedModel ? modelSupportsMaxEffort(focusedModel) : false;
    $[20] = focusedValue;
    $[21] = focusedSupportsEffort;
    $[22] = t8;
  } else {
    focusedSupportsEffort = $[21];
    t8 = $[22];
  }
  const focusedSupportsMax = t8;
  const focusedModelForEffort = resolveOptionModel(focusedValue);
  const focusedSupportsXHigh = focusedModelForEffort ? modelSupportsXHighEffort(focusedModelForEffort) : false;
  let t9;
  if ($[23] !== focusedValue) {
    t9 = getDefaultEffortLevelForOption(focusedValue);
    $[23] = focusedValue;
    $[24] = t9;
  } else {
    t9 = $[24];
  }
  const focusedDefaultEffort = t9;
  const displayEffort = (effort === "max" && !focusedSupportsMax) || (effort === "xhigh" && !focusedSupportsXHigh) ? "high" : effort;
  let t10;
  if ($[25] !== effortValue || $[26] !== hasToggledEffort) {
    t10 = value => {
      setFocusedValue(value);
      if (!hasToggledEffort && effortValue === undefined) {
        setEffort(getDefaultEffortLevelForOption(value));
      }
    };
    $[25] = effortValue;
    $[26] = hasToggledEffort;
    $[27] = t10;
  } else {
    t10 = $[27];
  }
  const handleFocus = t10;
  const handleCycleEffort = direction => {
    if (!focusedSupportsEffort) {
      return;
    }
    setEffort(prev => cycleEffortLevel(prev ?? focusedDefaultEffort, direction, focusedSupportsMax, focusedSupportsXHigh));
    setHasToggledEffort(true);
  };
  let t12;
  if ($[32] !== handleCycleEffort) {
    t12 = {
      "modelPicker:decreaseEffort": () => handleCycleEffort("left"),
      "modelPicker:increaseEffort": () => handleCycleEffort("right")
    };
    $[32] = handleCycleEffort;
    $[33] = t12;
  } else {
    t12 = $[33];
  }
  let t13;
  if ($[34] === Symbol.for("react.memo_cache_sentinel")) {
    t13 = {
      context: "ModelPicker"
    };
    $[34] = t13;
  } else {
    t13 = $[34];
  }
  useKeybindings(t12, t13);
  let t14;
  if ($[35] !== effort || $[36] !== hasToggledEffort || $[37] !== onSelect || $[38] !== setAppState || $[39] !== skipSettingsWrite) {
    t14 = function handleSelect(value_0) {
      logEvent("tengu_model_command_menu_effort", {
        effort: effort as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      if (!skipSettingsWrite) {
        const effortLevel = resolvePickerEffortPersistence(effort, getDefaultEffortLevelForOption(value_0), getSettingsForSource("userSettings")?.effortLevel, hasToggledEffort);
        const persistable = toPersistableEffort(effortLevel);
        if (persistable !== undefined) {
          updateSettingsForSource("userSettings", {
            effortLevel: persistable
          });
        }
        setAppState(prev_0 => ({
          ...prev_0,
          effortValue: effortLevel
        }));
      }
      const selectedModel = resolveOptionModel(value_0);
      const selectedEffort = hasToggledEffort && selectedModel && modelSupportsEffort(selectedModel) ? effort : undefined;
      if (value_0 === NO_PREFERENCE) {
        onSelect(null, selectedEffort);
        return;
      }
      onSelect(value_0, selectedEffort);
    };
    $[35] = effort;
    $[36] = hasToggledEffort;
    $[37] = onSelect;
    $[38] = setAppState;
    $[39] = skipSettingsWrite;
    $[40] = t14;
  } else {
    t14 = $[40];
  }
  const handleSelect = t14;
  let t15;
  if ($[41] === Symbol.for("react.memo_cache_sentinel")) {
    t15 = <Text color="remember" bold={true}>Select model</Text>;
    $[41] = t15;
  } else {
    t15 = $[41];
  }
  const t16 = headerText ?? "Switch between Claude models. Applies to this session and future Claude Code sessions. For other/previous model names, specify with --model.";
  let t17;
  if ($[42] !== t16) {
    t17 = <Text dimColor={true}>{t16}</Text>;
    $[42] = t16;
    $[43] = t17;
  } else {
    t17 = $[43];
  }
  let t18;
  if ($[44] !== sessionModel) {
    t18 = sessionModel && <Text dimColor={true}>Currently using {modelDisplayString(sessionModel)} for this session (set by plan mode). Selecting a model will undo this.</Text>;
    $[44] = sessionModel;
    $[45] = t18;
  } else {
    t18 = $[45];
  }
  let t19;
  if ($[46] !== t17 || $[47] !== t18) {
    t19 = <Box marginBottom={1} flexDirection="column">{t15}{t17}{t18}</Box>;
    $[46] = t17;
    $[47] = t18;
    $[48] = t19;
  } else {
    t19 = $[48];
  }
  const t20 = onCancel ?? _temp4;
  let t21;
  if ($[49] !== handleFocus || $[50] !== handleSelect || $[51] !== initialFocusValue || $[52] !== initialValue || $[53] !== selectOptions || $[54] !== t20 || $[55] !== visibleCount) {
    t21 = <Box flexDirection="column"><Select defaultValue={initialValue} defaultFocusValue={initialFocusValue} options={selectOptions} onChange={handleSelect} onFocus={handleFocus} onCancel={t20} visibleOptionCount={visibleCount} /></Box>;
    $[49] = handleFocus;
    $[50] = handleSelect;
    $[51] = initialFocusValue;
    $[52] = initialValue;
    $[53] = selectOptions;
    $[54] = t20;
    $[55] = visibleCount;
    $[56] = t21;
  } else {
    t21 = $[56];
  }
  let t22;
  if ($[57] !== hiddenCount) {
    t22 = hiddenCount > 0 && <Box paddingLeft={3}><Text dimColor={true}>and {hiddenCount} more…</Text></Box>;
    $[57] = hiddenCount;
    $[58] = t22;
  } else {
    t22 = $[58];
  }
  let t23;
  if ($[59] !== t21 || $[60] !== t22) {
    t23 = <Box flexDirection="column" marginBottom={1}>{t21}{t22}</Box>;
    $[59] = t21;
    $[60] = t22;
    $[61] = t23;
  } else {
    t23 = $[61];
  }
  let t24;
  if ($[62] !== displayEffort || $[63] !== focusedDefaultEffort || $[64] !== focusedModelName || $[65] !== focusedSupportsEffort) {
    t24 = <Box marginBottom={1} flexDirection="column">{focusedSupportsEffort ? <Text dimColor={true}><EffortLevelIndicator effort={displayEffort} />{" "}{capitalize(displayEffort)} effort{displayEffort === focusedDefaultEffort ? " (default)" : ""}{" "}<Text color="subtle">← → to adjust</Text></Text> : <Text color="subtle"><EffortLevelIndicator effort={undefined} /> Effort not supported{focusedModelName ? ` for ${focusedModelName}` : ""}</Text>}</Box>;
    $[62] = displayEffort;
    $[63] = focusedDefaultEffort;
    $[64] = focusedModelName;
    $[65] = focusedSupportsEffort;
    $[66] = t24;
  } else {
    t24 = $[66];
  }
  let t25;
  if ($[67] !== showFastModeNotice) {
    t25 = isFastModeEnabled() ? showFastModeNotice ? <Box marginBottom={1}><Text dimColor={true}>Fast mode is <Text bold={true}>ON</Text> and available with{" "}{FAST_MODE_MODEL_DISPLAY} only (/fast). Switching to other models turn off fast mode.</Text></Box> : isFastModeAvailable() && !isFastModeCooldown() ? <Box marginBottom={1}><Text dimColor={true}>Use <Text bold={true}>/fast</Text> to turn on Fast mode ({FAST_MODE_MODEL_DISPLAY} only).</Text></Box> : null : null;
    $[67] = showFastModeNotice;
    $[68] = t25;
  } else {
    t25 = $[68];
  }
  let t26;
  if ($[69] !== t19 || $[70] !== t23 || $[71] !== t24 || $[72] !== t25) {
    t26 = <Box flexDirection="column">{t19}{t23}{t24}{t25}</Box>;
    $[69] = t19;
    $[70] = t23;
    $[71] = t24;
    $[72] = t25;
    $[73] = t26;
  } else {
    t26 = $[73];
  }
  let t27;
  if ($[74] !== exitState || $[75] !== isStandaloneCommand) {
    t27 = isStandaloneCommand && <Text dimColor={true} italic={true}>{exitState.pending ? <>Press {exitState.keyName} again to exit</> : <Byline><KeyboardShortcutHint shortcut="Enter" action="confirm" /><ConfigurableShortcutHint action="select:cancel" context="Select" fallback="Esc" description="exit" /></Byline>}</Text>;
    $[74] = exitState;
    $[75] = isStandaloneCommand;
    $[76] = t27;
  } else {
    t27 = $[76];
  }
  let t28;
  if ($[77] !== t26 || $[78] !== t27) {
    t28 = <Box flexDirection="column">{t26}{t27}</Box>;
    $[77] = t26;
    $[78] = t27;
    $[79] = t28;
  } else {
    t28 = $[79];
  }
  const content = t28;
  if (!isStandaloneCommand) {
    return content;
  }
  let t29;
  if ($[80] !== content) {
    t29 = <Pane color="permission">{content}</Pane>;
    $[80] = content;
    $[81] = t29;
  } else {
    t29 = $[81];
  }
  return t29;
}
function _temp4() {}
function _temp3(opt_0) {
  return {
    ...opt_0,
    value: opt_0.value === null ? NO_PREFERENCE : opt_0.value
  };
}
function _temp2(s_0) {
  return s_0.effortValue;
}
function _temp(s) {
  return isFastModeEnabled() ? s.fastMode : false;
}
function resolveOptionModel(value?: string): string | undefined {
  if (!value) return undefined;
  return value === NO_PREFERENCE ? getDefaultMainLoopModel() : parseUserSpecifiedModel(value);
}
function EffortLevelIndicator(t0) {
  const $ = _c(5);
  const {
    effort
  } = t0;
  const t1 = effort ? "claude" : "subtle";
  const t2 = effort ?? "low";
  let t3;
  if ($[0] !== t2) {
    t3 = effortLevelToSymbol(t2);
    $[0] = t2;
    $[1] = t3;
  } else {
    t3 = $[1];
  }
  let t4;
  if ($[2] !== t1 || $[3] !== t3) {
    t4 = <Text color={t1}>{t3}</Text>;
    $[2] = t1;
    $[3] = t3;
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  return t4;
}
function cycleEffortLevel(current: EffortLevel, direction: 'left' | 'right', includeMax: boolean, includeXHigh: boolean): EffortLevel {
  const levels: EffortLevel[] = ['low', 'medium', 'high'];
  if (includeXHigh) levels.push('xhigh');
  if (includeMax) levels.push('max');
  // If the current level isn't in the cycle after switching models, clamp to 'high'.
  const idx = levels.indexOf(current);
  const currentIndex = idx !== -1 ? idx : levels.indexOf('high');
  if (direction === 'right') {
    return levels[(currentIndex + 1) % levels.length]!;
  } else {
    return levels[(currentIndex - 1 + levels.length) % levels.length]!;
  }
}
function getDefaultEffortLevelForOption(value?: string): EffortLevel {
  const resolved = resolveOptionModel(value) ?? getDefaultMainLoopModel();
  const defaultValue = getDefaultEffortForModel(resolved);
  return defaultValue !== undefined ? convertEffortValueToLevel(defaultValue) : 'high';
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJjYXBpdGFsaXplIiwiUmVhY3QiLCJ1c2VDYWxsYmFjayIsInVzZU1lbW8iLCJ1c2VTdGF0ZSIsInVzZUV4aXRPbkN0cmxDRFdpdGhLZXliaW5kaW5ncyIsIkFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMiLCJsb2dFdmVudCIsIkZBU1RfTU9ERV9NT0RFTF9ESVNQTEFZIiwiaXNGYXN0TW9kZUF2YWlsYWJsZSIsImlzRmFzdE1vZGVDb29sZG93biIsImlzRmFzdE1vZGVFbmFibGVkIiwiQm94IiwiVGV4dCIsInVzZUtleWJpbmRpbmdzIiwidXNlQXBwU3RhdGUiLCJ1c2VTZXRBcHBTdGF0ZSIsImNvbnZlcnRFZmZvcnRWYWx1ZVRvTGV2ZWwiLCJFZmZvcnRMZXZlbCIsImdldERlZmF1bHRFZmZvcnRGb3JNb2RlbCIsIm1vZGVsU3VwcG9ydHNFZmZvcnQiLCJtb2RlbFN1cHBvcnRzTWF4RWZmb3J0IiwicmVzb2x2ZVBpY2tlckVmZm9ydFBlcnNpc3RlbmNlIiwidG9QZXJzaXN0YWJsZUVmZm9ydCIsImdldERlZmF1bHRNYWluTG9vcE1vZGVsIiwiTW9kZWxTZXR0aW5nIiwibW9kZWxEaXNwbGF5U3RyaW5nIiwicGFyc2VVc2VyU3BlY2lmaWVkTW9kZWwiLCJnZXRNb2RlbE9wdGlvbnMiLCJnZXRTZXR0aW5nc0ZvclNvdXJjZSIsInVwZGF0ZVNldHRpbmdzRm9yU291cmNlIiwiQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50IiwiU2VsZWN0IiwiQnlsaW5lIiwiS2V5Ym9hcmRTaG9ydGN1dEhpbnQiLCJQYW5lIiwiZWZmb3J0TGV2ZWxUb1N5bWJvbCIsIlByb3BzIiwiaW5pdGlhbCIsInNlc3Npb25Nb2RlbCIsIm9uU2VsZWN0IiwibW9kZWwiLCJlZmZvcnQiLCJvbkNhbmNlbCIsImlzU3RhbmRhbG9uZUNvbW1hbmQiLCJzaG93RmFzdE1vZGVOb3RpY2UiLCJoZWFkZXJUZXh0Iiwic2tpcFNldHRpbmdzV3JpdGUiLCJOT19QUkVGRVJFTkNFIiwiTW9kZWxQaWNrZXIiLCJ0MCIsIiQiLCJfYyIsInNldEFwcFN0YXRlIiwiZXhpdFN0YXRlIiwiaW5pdGlhbFZhbHVlIiwiZm9jdXNlZFZhbHVlIiwic2V0Rm9jdXNlZFZhbHVlIiwiaXNGYXN0TW9kZSIsIl90ZW1wIiwiaGFzVG9nZ2xlZEVmZm9ydCIsInNldEhhc1RvZ2dsZWRFZmZvcnQiLCJlZmZvcnRWYWx1ZSIsIl90ZW1wMiIsInQxIiwidW5kZWZpbmVkIiwic2V0RWZmb3J0IiwidDIiLCJ0MyIsIm1vZGVsT3B0aW9ucyIsInQ0IiwiYmIwIiwic29tZSIsIm9wdCIsInZhbHVlIiwidDUiLCJ0NiIsImxhYmVsIiwiZGVzY3JpcHRpb24iLCJ0NyIsIm9wdGlvbnNXaXRoSW5pdGlhbCIsIm1hcCIsIl90ZW1wMyIsInNlbGVjdE9wdGlvbnMiLCJfIiwiaW5pdGlhbEZvY3VzVmFsdWUiLCJ2aXNpYmxlQ291bnQiLCJNYXRoIiwibWluIiwibGVuZ3RoIiwiaGlkZGVuQ291bnQiLCJtYXgiLCJmaW5kIiwib3B0XzEiLCJmb2N1c2VkTW9kZWxOYW1lIiwiZm9jdXNlZFN1cHBvcnRzRWZmb3J0IiwidDgiLCJmb2N1c2VkTW9kZWwiLCJyZXNvbHZlT3B0aW9uTW9kZWwiLCJmb2N1c2VkU3VwcG9ydHNNYXgiLCJ0OSIsImdldERlZmF1bHRFZmZvcnRMZXZlbEZvck9wdGlvbiIsImZvY3VzZWREZWZhdWx0RWZmb3J0IiwiZGlzcGxheUVmZm9ydCIsInQxMCIsImhhbmRsZUZvY3VzIiwidDExIiwiZGlyZWN0aW9uIiwicHJldiIsImN5Y2xlRWZmb3J0TGV2ZWwiLCJoYW5kbGVDeWNsZUVmZm9ydCIsInQxMiIsIm1vZGVsUGlja2VyOmRlY3JlYXNlRWZmb3J0IiwibW9kZWxQaWNrZXI6aW5jcmVhc2VFZmZvcnQiLCJ0MTMiLCJTeW1ib2wiLCJmb3IiLCJjb250ZXh0IiwidDE0IiwiaGFuZGxlU2VsZWN0IiwidmFsdWVfMCIsImVmZm9ydExldmVsIiwicGVyc2lzdGFibGUiLCJwcmV2XzAiLCJzZWxlY3RlZE1vZGVsIiwic2VsZWN0ZWRFZmZvcnQiLCJ0MTUiLCJ0MTYiLCJ0MTciLCJ0MTgiLCJ0MTkiLCJ0MjAiLCJfdGVtcDQiLCJ0MjEiLCJ0MjIiLCJ0MjMiLCJ0MjQiLCJ0MjUiLCJ0MjYiLCJ0MjciLCJwZW5kaW5nIiwia2V5TmFtZSIsInQyOCIsImNvbnRlbnQiLCJ0MjkiLCJvcHRfMCIsInNfMCIsInMiLCJmYXN0TW9kZSIsIkVmZm9ydExldmVsSW5kaWNhdG9yIiwiY3VycmVudCIsImluY2x1ZGVNYXgiLCJsZXZlbHMiLCJpZHgiLCJpbmRleE9mIiwiY3VycmVudEluZGV4IiwicmVzb2x2ZWQiLCJkZWZhdWx0VmFsdWUiXSwic291cmNlcyI6WyJNb2RlbFBpY2tlci50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGNhcGl0YWxpemUgZnJvbSAnbG9kYXNoLWVzL2NhcGl0YWxpemUuanMnXG5pbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IHVzZUNhbGxiYWNrLCB1c2VNZW1vLCB1c2VTdGF0ZSB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgdXNlRXhpdE9uQ3RybENEV2l0aEtleWJpbmRpbmdzIH0gZnJvbSAnc3JjL2hvb2tzL3VzZUV4aXRPbkN0cmxDRFdpdGhLZXliaW5kaW5ncy5qcydcbmltcG9ydCB7XG4gIHR5cGUgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgbG9nRXZlbnQsXG59IGZyb20gJ3NyYy9zZXJ2aWNlcy9hbmFseXRpY3MvaW5kZXguanMnXG5pbXBvcnQge1xuICBGQVNUX01PREVfTU9ERUxfRElTUExBWSxcbiAgaXNGYXN0TW9kZUF2YWlsYWJsZSxcbiAgaXNGYXN0TW9kZUNvb2xkb3duLFxuICBpc0Zhc3RNb2RlRW5hYmxlZCxcbn0gZnJvbSAnc3JjL3V0aWxzL2Zhc3RNb2RlLmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vaW5rLmpzJ1xuaW1wb3J0IHsgdXNlS2V5YmluZGluZ3MgfSBmcm9tICcuLi9rZXliaW5kaW5ncy91c2VLZXliaW5kaW5nLmpzJ1xuaW1wb3J0IHsgdXNlQXBwU3RhdGUsIHVzZVNldEFwcFN0YXRlIH0gZnJvbSAnLi4vc3RhdGUvQXBwU3RhdGUuanMnXG5pbXBvcnQge1xuICBjb252ZXJ0RWZmb3J0VmFsdWVUb0xldmVsLFxuICB0eXBlIEVmZm9ydExldmVsLFxuICBnZXREZWZhdWx0RWZmb3J0Rm9yTW9kZWwsXG4gIG1vZGVsU3VwcG9ydHNFZmZvcnQsXG4gIG1vZGVsU3VwcG9ydHNNYXhFZmZvcnQsXG4gIG1vZGVsU3VwcG9ydHNYSGlnaEVmZm9ydCxcbiAgcmVzb2x2ZVBpY2tlckVmZm9ydFBlcnNpc3RlbmNlLFxuICB0b1BlcnNpc3RhYmxlRWZmb3J0LFxufSBmcm9tICcuLi91dGlscy9lZmZvcnQuanMnXG5pbXBvcnQge1xuICBnZXREZWZhdWx0TWFpbkxvb3BNb2RlbCxcbiAgdHlwZSBNb2RlbFNldHRpbmcsXG4gIG1vZGVsRGlzcGxheVN0cmluZyxcbiAgcGFyc2VVc2VyU3BlY2lmaWVkTW9kZWwsXG59IGZyb20gJy4uL3V0aWxzL21vZGVsL21vZGVsLmpzJ1xuaW1wb3J0IHsgZ2V0TW9kZWxPcHRpb25zIH0gZnJvbSAnLi4vdXRpbHMvbW9kZWwvbW9kZWxPcHRpb25zLmpzJ1xuaW1wb3J0IHtcbiAgZ2V0U2V0dGluZ3NGb3JTb3VyY2UsXG4gIHVwZGF0ZVNldHRpbmdzRm9yU291cmNlLFxufSBmcm9tICcuLi91dGlscy9zZXR0aW5ncy9zZXR0aW5ncy5qcydcbmltcG9ydCB7IENvbmZpZ3VyYWJsZVNob3J0Y3V0SGludCB9IGZyb20gJy4vQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50LmpzJ1xuaW1wb3J0IHsgU2VsZWN0IH0gZnJvbSAnLi9DdXN0b21TZWxlY3QvaW5kZXguanMnXG5pbXBvcnQgeyBCeWxpbmUgfSBmcm9tICcuL2Rlc2lnbi1zeXN0ZW0vQnlsaW5lLmpzJ1xuaW1wb3J0IHsgS2V5Ym9hcmRTaG9ydGN1dEhpbnQgfSBmcm9tICcuL2Rlc2lnbi1zeXN0ZW0vS2V5Ym9hcmRTaG9ydGN1dEhpbnQuanMnXG5pbXBvcnQgeyBQYW5lIH0gZnJvbSAnLi9kZXNpZ24tc3lzdGVtL1BhbmUuanMnXG5pbXBvcnQgeyBlZmZvcnRMZXZlbFRvU3ltYm9sIH0gZnJvbSAnLi9FZmZvcnRJbmRpY2F0b3IuanMnXG5cbmV4cG9ydCB0eXBlIFByb3BzID0ge1xuICBpbml0aWFsOiBzdHJpbmcgfCBudWxsXG4gIHNlc3Npb25Nb2RlbD86IE1vZGVsU2V0dGluZ1xuICBvblNlbGVjdDogKG1vZGVsOiBzdHJpbmcgfCBudWxsLCBlZmZvcnQ6IEVmZm9ydExldmVsIHwgdW5kZWZpbmVkKSA9PiB2b2lkXG4gIG9uQ2FuY2VsPzogKCkgPT4gdm9pZFxuICBpc1N0YW5kYWxvbmVDb21tYW5kPzogYm9vbGVhblxuICBzaG93RmFzdE1vZGVOb3RpY2U/OiBib29sZWFuXG4gIC8qKiBPdmVycmlkZXMgdGhlIGRpbSBoZWFkZXIgbGluZSBiZWxvdyBcIlNlbGVjdCBtb2RlbFwiLiAqL1xuICBoZWFkZXJUZXh0Pzogc3RyaW5nXG4gIC8qKlxuICAgKiBXaGVuIHRydWUsIHNraXAgd3JpdGluZyBlZmZvcnRMZXZlbCB0byB1c2VyU2V0dGluZ3Mgb24gc2VsZWN0aW9uLlxuICAgKiBVc2VkIGJ5IHRoZSBhc3Npc3RhbnQgaW5zdGFsbGVyIHdpemFyZCB3aGVyZSB0aGUgbW9kZWwgY2hvaWNlIGlzXG4gICAqIHByb2plY3Qtc2NvcGVkICh3cml0dGVuIHRvIHRoZSBhc3Npc3RhbnQncyAuY2xhdWRlL3NldHRpbmdzLmpzb24gdmlhXG4gICAqIGluc3RhbGwudHMpIGFuZCBzaG91bGQgbm90IGxlYWsgdG8gdGhlIHVzZXIncyBnbG9iYWwgfi8uY2xhdWRlL3NldHRpbmdzLlxuICAgKi9cbiAgc2tpcFNldHRpbmdzV3JpdGU/OiBib29sZWFuXG59XG5cbmNvbnN0IE5PX1BSRUZFUkVOQ0UgPSAnX19OT19QUkVGRVJFTkNFX18nXG5cbmV4cG9ydCBmdW5jdGlvbiBNb2RlbFBpY2tlcih7XG4gIGluaXRpYWwsXG4gIHNlc3Npb25Nb2RlbCxcbiAgb25TZWxlY3QsXG4gIG9uQ2FuY2VsLFxuICBpc1N0YW5kYWxvbmVDb21tYW5kLFxuICBzaG93RmFzdE1vZGVOb3RpY2UsXG4gIGhlYWRlclRleHQsXG4gIHNraXBTZXR0aW5nc1dyaXRlLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBzZXRBcHBTdGF0ZSA9IHVzZVNldEFwcFN0YXRlKClcbiAgY29uc3QgZXhpdFN0YXRlID0gdXNlRXhpdE9uQ3RybENEV2l0aEtleWJpbmRpbmdzKClcbiAgY29uc3QgbWF4VmlzaWJsZSA9IDEwXG5cbiAgY29uc3QgaW5pdGlhbFZhbHVlID0gaW5pdGlhbCA9PT0gbnVsbCA/IE5PX1BSRUZFUkVOQ0UgOiBpbml0aWFsXG4gIGNvbnN0IFtmb2N1c2VkVmFsdWUsIHNldEZvY3VzZWRWYWx1ZV0gPSB1c2VTdGF0ZTxzdHJpbmcgfCB1bmRlZmluZWQ+KFxuICAgIGluaXRpYWxWYWx1ZSxcbiAgKVxuXG4gIGNvbnN0IGlzRmFzdE1vZGUgPSB1c2VBcHBTdGF0ZShzID0+XG4gICAgaXNGYXN0TW9kZUVuYWJsZWQoKSA/IHMuZmFzdE1vZGUgOiBmYWxzZSxcbiAgKVxuXG4gIGNvbnN0IFtoYXNUb2dnbGVkRWZmb3J0LCBzZXRIYXNUb2dnbGVkRWZmb3J0XSA9IHVzZVN0YXRlKGZhbHNlKVxuICBjb25zdCBlZmZvcnRWYWx1ZSA9IHVzZUFwcFN0YXRlKHMgPT4gcy5lZmZvcnRWYWx1ZSlcbiAgY29uc3QgW2VmZm9ydCwgc2V0RWZmb3J0XSA9IHVzZVN0YXRlPEVmZm9ydExldmVsIHwgdW5kZWZpbmVkPihcbiAgICBlZmZvcnRWYWx1ZSAhPT0gdW5kZWZpbmVkXG4gICAgICA/IGNvbnZlcnRFZmZvcnRWYWx1ZVRvTGV2ZWwoZWZmb3J0VmFsdWUpXG4gICAgICA6IHVuZGVmaW5lZCxcbiAgKVxuXG4gIC8vIE1lbW9pemUgYWxsIGRlcml2ZWQgdmFsdWVzIHRvIHByZXZlbnQgcmUtcmVuZGVyc1xuICBjb25zdCBtb2RlbE9wdGlvbnMgPSB1c2VNZW1vKFxuICAgICgpID0+IGdldE1vZGVsT3B0aW9ucyhpc0Zhc3RNb2RlID8/IGZhbHNlKSxcbiAgICBbaXNGYXN0TW9kZV0sXG4gIClcblxuICAvLyBFbnN1cmUgdGhlIGluaXRpYWwgdmFsdWUgaXMgaW4gdGhlIG9wdGlvbnMgbGlzdFxuICAvLyBUaGlzIGhhbmRsZXMgZWRnZSBjYXNlcyB3aGVyZSB0aGUgdXNlcidzIGN1cnJlbnQgbW9kZWwgKGUuZy4sICdoYWlrdScgZm9yIDNQIHVzZXJzKVxuICAvLyBpcyBub3QgaW4gdGhlIGJhc2Ugb3B0aW9ucyBidXQgc2hvdWxkIHN0aWxsIGJlIHNlbGVjdGFibGUgYW5kIHNob3duIGFzIHNlbGVjdGVkXG4gIGNvbnN0IG9wdGlvbnNXaXRoSW5pdGlhbCA9IHVzZU1lbW8oKCkgPT4ge1xuICAgIGlmIChpbml0aWFsICE9PSBudWxsICYmICFtb2RlbE9wdGlvbnMuc29tZShvcHQgPT4gb3B0LnZhbHVlID09PSBpbml0aWFsKSkge1xuICAgICAgcmV0dXJuIFtcbiAgICAgICAgLi4ubW9kZWxPcHRpb25zLFxuICAgICAgICB7XG4gICAgICAgICAgdmFsdWU6IGluaXRpYWwsXG4gICAgICAgICAgbGFiZWw6IG1vZGVsRGlzcGxheVN0cmluZyhpbml0aWFsKSxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogJ0N1cnJlbnQgbW9kZWwnLFxuICAgICAgICB9LFxuICAgICAgXVxuICAgIH1cbiAgICByZXR1cm4gbW9kZWxPcHRpb25zXG4gIH0sIFttb2RlbE9wdGlvbnMsIGluaXRpYWxdKVxuXG4gIGNvbnN0IHNlbGVjdE9wdGlvbnMgPSB1c2VNZW1vKFxuICAgICgpID0+XG4gICAgICBvcHRpb25zV2l0aEluaXRpYWwubWFwKG9wdCA9PiAoe1xuICAgICAgICAuLi5vcHQsXG4gICAgICAgIHZhbHVlOiBvcHQudmFsdWUgPT09IG51bGwgPyBOT19QUkVGRVJFTkNFIDogb3B0LnZhbHVlLFxuICAgICAgfSkpLFxuICAgIFtvcHRpb25zV2l0aEluaXRpYWxdLFxuICApXG4gIGNvbnN0IGluaXRpYWxGb2N1c1ZhbHVlID0gdXNlTWVtbyhcbiAgICAoKSA9PlxuICAgICAgc2VsZWN0T3B0aW9ucy5zb21lKF8gPT4gXy52YWx1ZSA9PT0gaW5pdGlhbFZhbHVlKVxuICAgICAgICA/IGluaXRpYWxWYWx1ZVxuICAgICAgICA6IChzZWxlY3RPcHRpb25zWzBdPy52YWx1ZSA/PyB1bmRlZmluZWQpLFxuICAgIFtzZWxlY3RPcHRpb25zLCBpbml0aWFsVmFsdWVdLFxuICApXG4gIGNvbnN0IHZpc2libGVDb3VudCA9IE1hdGgubWluKG1heFZpc2libGUsIHNlbGVjdE9wdGlvbnMubGVuZ3RoKVxuICBjb25zdCBoaWRkZW5Db3VudCA9IE1hdGgubWF4KDAsIHNlbGVjdE9wdGlvbnMubGVuZ3RoIC0gdmlzaWJsZUNvdW50KVxuXG4gIGNvbnN0IGZvY3VzZWRNb2RlbE5hbWUgPSBzZWxlY3RPcHRpb25zLmZpbmQoXG4gICAgb3B0ID0+IG9wdC52YWx1ZSA9PT0gZm9jdXNlZFZhbHVlLFxuICApPy5sYWJlbFxuICBjb25zdCBmb2N1c2VkTW9kZWwgPSByZXNvbHZlT3B0aW9uTW9kZWwoZm9jdXNlZFZhbHVlKVxuICBjb25zdCBmb2N1c2VkU3VwcG9ydHNFZmZvcnQgPSBmb2N1c2VkTW9kZWxcbiAgICA/IG1vZGVsU3VwcG9ydHNFZmZvcnQoZm9jdXNlZE1vZGVsKVxuICAgIDogZmFsc2VcbiAgY29uc3QgZm9jdXNlZFN1cHBvcnRzTWF4ID0gZm9jdXNlZE1vZGVsXG4gICAgPyBtb2RlbFN1cHBvcnRzTWF4RWZmb3J0KGZvY3VzZWRNb2RlbClcbiAgICA6IGZhbHNlXG4gIGNvbnN0IGZvY3VzZWRTdXBwb3J0c1hIaWdoID0gZm9jdXNlZE1vZGVsXG4gICAgPyBtb2RlbFN1cHBvcnRzWEhpZ2hFZmZvcnQoZm9jdXNlZE1vZGVsKVxuICAgIDogZmFsc2VcbiAgY29uc3QgZm9jdXNlZERlZmF1bHRFZmZvcnQgPSBnZXREZWZhdWx0RWZmb3J0TGV2ZWxGb3JPcHRpb24oZm9jdXNlZFZhbHVlKVxuICAvLyBDbGFtcCBkaXNwbGF5IHdoZW4gdGhlIGZvY3VzZWQgbW9kZWwgZG9lc24ndCBzdXBwb3J0IHRoZSBzZWxlY3RlZCBsZXZlbC5cbiAgLy8gcmVzb2x2ZUFwcGxpZWRFZmZvcnQoKSBkb2VzIHRoZSBzYW1lIGRvd25ncmFkZSBhdCBBUEktc2VuZCB0aW1lLlxuICBjb25zdCBkaXNwbGF5RWZmb3J0ID1cbiAgICAoZWZmb3J0ID09PSAnbWF4JyAmJiAhZm9jdXNlZFN1cHBvcnRzTWF4KSB8fFxuICAgIChlZmZvcnQgPT09ICd4aGlnaCcgJiYgIWZvY3VzZWRTdXBwb3J0c1hIaWdoKVxuICAgICAgPyAnaGlnaCdcbiAgICAgIDogZWZmb3J0XG5cbiAgY29uc3QgaGFuZGxlRm9jdXMgPSB1c2VDYWxsYmFjayhcbiAgICAodmFsdWU6IHN0cmluZykgPT4ge1xuICAgICAgc2V0Rm9jdXNlZFZhbHVlKHZhbHVlKVxuICAgICAgaWYgKCFoYXNUb2dnbGVkRWZmb3J0ICYmIGVmZm9ydFZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgc2V0RWZmb3J0KGdldERlZmF1bHRFZmZvcnRMZXZlbEZvck9wdGlvbih2YWx1ZSkpXG4gICAgICB9XG4gICAgfSxcbiAgICBbaGFzVG9nZ2xlZEVmZm9ydCwgZWZmb3J0VmFsdWVdLFxuICApXG5cbiAgLy8gRWZmb3J0IGxldmVsIGN5Y2xpbmcga2V5YmluZGluZ3NcbiAgY29uc3QgaGFuZGxlQ3ljbGVFZmZvcnQgPSB1c2VDYWxsYmFjayhcbiAgICAoZGlyZWN0aW9uOiAnbGVmdCcgfCAncmlnaHQnKSA9PiB7XG4gICAgICBpZiAoIWZvY3VzZWRTdXBwb3J0c0VmZm9ydCkgcmV0dXJuXG4gICAgICBzZXRFZmZvcnQocHJldiA9PlxuICAgICAgICBjeWNsZUVmZm9ydExldmVsKFxuICAgICAgICAgIHByZXYgPz8gZm9jdXNlZERlZmF1bHRFZmZvcnQsXG4gICAgICAgICAgZGlyZWN0aW9uLFxuICAgICAgICAgIGZvY3VzZWRTdXBwb3J0c01heCxcbiAgICAgICAgICBmb2N1c2VkU3VwcG9ydHNYSGlnaCxcbiAgICAgICAgKSxcbiAgICAgIClcbiAgICAgIHNldEhhc1RvZ2dsZWRFZmZvcnQodHJ1ZSlcbiAgICB9LFxuICAgIFtmb2N1c2VkU3VwcG9ydHNFZmZvcnQsIGZvY3VzZWRTdXBwb3J0c01heCwgZm9jdXNlZFN1cHBvcnRzWEhpZ2gsIGZvY3VzZWREZWZhdWx0RWZmb3J0XSxcbiAgKVxuXG4gIHVzZUtleWJpbmRpbmdzKFxuICAgIHtcbiAgICAgICdtb2RlbFBpY2tlcjpkZWNyZWFzZUVmZm9ydCc6ICgpID0+IGhhbmRsZUN5Y2xlRWZmb3J0KCdsZWZ0JyksXG4gICAgICAnbW9kZWxQaWNrZXI6aW5jcmVhc2VFZmZvcnQnOiAoKSA9PiBoYW5kbGVDeWNsZUVmZm9ydCgncmlnaHQnKSxcbiAgICB9LFxuICAgIHsgY29udGV4dDogJ01vZGVsUGlja2VyJyB9LFxuICApXG5cbiAgZnVuY3Rpb24gaGFuZGxlU2VsZWN0KHZhbHVlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBsb2dFdmVudCgndGVuZ3VfbW9kZWxfY29tbWFuZF9tZW51X2VmZm9ydCcsIHtcbiAgICAgIGVmZm9ydDpcbiAgICAgICAgZWZmb3J0IGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgfSlcbiAgICBpZiAoIXNraXBTZXR0aW5nc1dyaXRlKSB7XG4gICAgICAvLyBQcmlvciBjb21lcyBmcm9tIHVzZXJTZXR0aW5ncyBvbiBkaXNrIFx1MjAxNCBOT1QgbWVyZ2VkIHNldHRpbmdzICh3aGljaFxuICAgICAgLy8gaW5jbHVkZXMgcHJvamVjdC9wb2xpY3kgbGF5ZXJzIHRoYXQgbXVzdCBub3QgbGVhayBpbnRvIHRoZSB1c2VyJ3NcbiAgICAgIC8vIGdsb2JhbCB+Ly5jbGF1ZGUvc2V0dGluZ3MuanNvbiksIGFuZCBOT1QgQXBwU3RhdGUuZWZmb3J0VmFsdWUgKHdoaWNoXG4gICAgICAvLyBpbmNsdWRlcyBzZXNzaW9uLWVwaGVtZXJhbCBzb3VyY2VzIGxpa2UgLS1lZmZvcnQgQ0xJIGZsYWcpLlxuICAgICAgLy8gU2VlIHJlc29sdmVQaWNrZXJFZmZvcnRQZXJzaXN0ZW5jZSBKU0RvYy5cbiAgICAgIGNvbnN0IGVmZm9ydExldmVsID0gcmVzb2x2ZVBpY2tlckVmZm9ydFBlcnNpc3RlbmNlKFxuICAgICAgICBlZmZvcnQsXG4gICAgICAgIGdldERlZmF1bHRFZmZvcnRMZXZlbEZvck9wdGlvbih2YWx1ZSksXG4gICAgICAgIGdldFNldHRpbmdzRm9yU291cmNlKCd1c2VyU2V0dGluZ3MnKT8uZWZmb3J0TGV2ZWwsXG4gICAgICAgIGhhc1RvZ2dsZWRFZmZvcnQsXG4gICAgICApXG4gICAgICBjb25zdCBwZXJzaXN0YWJsZSA9IHRvUGVyc2lzdGFibGVFZmZvcnQoZWZmb3J0TGV2ZWwpXG4gICAgICBpZiAocGVyc2lzdGFibGUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB1cGRhdGVTZXR0aW5nc0ZvclNvdXJjZSgndXNlclNldHRpbmdzJywgeyBlZmZvcnRMZXZlbDogcGVyc2lzdGFibGUgfSlcbiAgICAgIH1cbiAgICAgIHNldEFwcFN0YXRlKHByZXYgPT4gKHsgLi4ucHJldiwgZWZmb3J0VmFsdWU6IGVmZm9ydExldmVsIH0pKVxuICAgIH1cblxuICAgIGNvbnN0IHNlbGVjdGVkTW9kZWwgPSByZXNvbHZlT3B0aW9uTW9kZWwodmFsdWUpXG4gICAgY29uc3Qgc2VsZWN0ZWRFZmZvcnQgPVxuICAgICAgaGFzVG9nZ2xlZEVmZm9ydCAmJiBzZWxlY3RlZE1vZGVsICYmIG1vZGVsU3VwcG9ydHNFZmZvcnQoc2VsZWN0ZWRNb2RlbClcbiAgICAgICAgPyBlZmZvcnRcbiAgICAgICAgOiB1bmRlZmluZWRcbiAgICBpZiAodmFsdWUgPT09IE5PX1BSRUZFUkVOQ0UpIHtcbiAgICAgIG9uU2VsZWN0KG51bGwsIHNlbGVjdGVkRWZmb3J0KVxuICAgICAgcmV0dXJuXG4gICAgfVxuICAgIG9uU2VsZWN0KHZhbHVlLCBzZWxlY3RlZEVmZm9ydClcbiAgfVxuXG4gIGNvbnN0IGNvbnRlbnQgPSAoXG4gICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgICAgPEJveCBtYXJnaW5Cb3R0b209ezF9IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgICAgICA8VGV4dCBjb2xvcj1cInJlbWVtYmVyXCIgYm9sZD5cbiAgICAgICAgICAgIFNlbGVjdCBtb2RlbFxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgICA8VGV4dCBkaW1Db2xvcj5cbiAgICAgICAgICAgIHtoZWFkZXJUZXh0ID8/XG4gICAgICAgICAgICAgICdTd2l0Y2ggYmV0d2VlbiBDbGF1ZGUgbW9kZWxzLiBBcHBsaWVzIHRvIHRoaXMgc2Vzc2lvbiBhbmQgZnV0dXJlIENsYXVkZSBDb2RlIHNlc3Npb25zLiBGb3Igb3RoZXIvcHJldmlvdXMgbW9kZWwgbmFtZXMsIHNwZWNpZnkgd2l0aCAtLW1vZGVsLid9XG4gICAgICAgICAgPC9UZXh0PlxuICAgICAgICAgIHtzZXNzaW9uTW9kZWwgJiYgKFxuICAgICAgICAgICAgPFRleHQgZGltQ29sb3I+XG4gICAgICAgICAgICAgIEN1cnJlbnRseSB1c2luZyB7bW9kZWxEaXNwbGF5U3RyaW5nKHNlc3Npb25Nb2RlbCl9IGZvciB0aGlzXG4gICAgICAgICAgICAgIHNlc3Npb24gKHNldCBieSBwbGFuIG1vZGUpLiBTZWxlY3RpbmcgYSBtb2RlbCB3aWxsIHVuZG8gdGhpcy5cbiAgICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgICApfVxuICAgICAgICA8L0JveD5cblxuICAgICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIiBtYXJnaW5Cb3R0b209ezF9PlxuICAgICAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICAgICAgPFNlbGVjdFxuICAgICAgICAgICAgICBkZWZhdWx0VmFsdWU9e2luaXRpYWxWYWx1ZX1cbiAgICAgICAgICAgICAgZGVmYXVsdEZvY3VzVmFsdWU9e2luaXRpYWxGb2N1c1ZhbHVlfVxuICAgICAgICAgICAgICBvcHRpb25zPXtzZWxlY3RPcHRpb25zfVxuICAgICAgICAgICAgICBvbkNoYW5nZT17aGFuZGxlU2VsZWN0fVxuICAgICAgICAgICAgICBvbkZvY3VzPXtoYW5kbGVGb2N1c31cbiAgICAgICAgICAgICAgb25DYW5jZWw9e29uQ2FuY2VsID8/ICgoKSA9PiB7fSl9XG4gICAgICAgICAgICAgIHZpc2libGVPcHRpb25Db3VudD17dmlzaWJsZUNvdW50fVxuICAgICAgICAgICAgLz5cbiAgICAgICAgICA8L0JveD5cbiAgICAgICAgICB7aGlkZGVuQ291bnQgPiAwICYmIChcbiAgICAgICAgICAgIDxCb3ggcGFkZGluZ0xlZnQ9ezN9PlxuICAgICAgICAgICAgICA8VGV4dCBkaW1Db2xvcj5hbmQge2hpZGRlbkNvdW50fSBtb3JlXHUyMDI2PC9UZXh0PlxuICAgICAgICAgICAgPC9Cb3g+XG4gICAgICAgICAgKX1cbiAgICAgICAgPC9Cb3g+XG5cbiAgICAgICAgPEJveCBtYXJnaW5Cb3R0b209ezF9IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgICAgICB7Zm9jdXNlZFN1cHBvcnRzRWZmb3J0ID8gKFxuICAgICAgICAgICAgPFRleHQgZGltQ29sb3I+XG4gICAgICAgICAgICAgIDxFZmZvcnRMZXZlbEluZGljYXRvciBlZmZvcnQ9e2Rpc3BsYXlFZmZvcnR9IC8+eycgJ31cbiAgICAgICAgICAgICAge2NhcGl0YWxpemUoZGlzcGxheUVmZm9ydCl9IGVmZm9ydFxuICAgICAgICAgICAgICB7ZGlzcGxheUVmZm9ydCA9PT0gZm9jdXNlZERlZmF1bHRFZmZvcnQgPyBgIChkZWZhdWx0KWAgOiBgYH17JyAnfVxuICAgICAgICAgICAgICA8VGV4dCBjb2xvcj1cInN1YnRsZVwiPlx1MjE5MCBcdTIxOTIgdG8gYWRqdXN0PC9UZXh0PlxuICAgICAgICAgICAgPC9UZXh0PlxuICAgICAgICAgICkgOiAoXG4gICAgICAgICAgICA8VGV4dCBjb2xvcj1cInN1YnRsZVwiPlxuICAgICAgICAgICAgICA8RWZmb3J0TGV2ZWxJbmRpY2F0b3IgZWZmb3J0PXt1bmRlZmluZWR9IC8+IEVmZm9ydCBub3Qgc3VwcG9ydGVkXG4gICAgICAgICAgICAgIHtmb2N1c2VkTW9kZWxOYW1lID8gYCBmb3IgJHtmb2N1c2VkTW9kZWxOYW1lfWAgOiAnJ31cbiAgICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgICApfVxuICAgICAgICA8L0JveD5cblxuICAgICAgICB7aXNGYXN0TW9kZUVuYWJsZWQoKSA/IChcbiAgICAgICAgICBzaG93RmFzdE1vZGVOb3RpY2UgPyAoXG4gICAgICAgICAgICA8Qm94IG1hcmdpbkJvdHRvbT17MX0+XG4gICAgICAgICAgICAgIDxUZXh0IGRpbUNvbG9yPlxuICAgICAgICAgICAgICAgIEZhc3QgbW9kZSBpcyA8VGV4dCBib2xkPk9OPC9UZXh0PiBhbmQgYXZhaWxhYmxlIHdpdGh7JyAnfVxuICAgICAgICAgICAgICAgIHtGQVNUX01PREVfTU9ERUxfRElTUExBWX0gb25seSAoL2Zhc3QpLiBTd2l0Y2hpbmcgdG8gb3RoZXJcbiAgICAgICAgICAgICAgICBtb2RlbHMgdHVybiBvZmYgZmFzdCBtb2RlLlxuICAgICAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICApIDogaXNGYXN0TW9kZUF2YWlsYWJsZSgpICYmICFpc0Zhc3RNb2RlQ29vbGRvd24oKSA/IChcbiAgICAgICAgICAgIDxCb3ggbWFyZ2luQm90dG9tPXsxfT5cbiAgICAgICAgICAgICAgPFRleHQgZGltQ29sb3I+XG4gICAgICAgICAgICAgICAgVXNlIDxUZXh0IGJvbGQ+L2Zhc3Q8L1RleHQ+IHRvIHR1cm4gb24gRmFzdCBtb2RlIChcbiAgICAgICAgICAgICAgICB7RkFTVF9NT0RFX01PREVMX0RJU1BMQVl9IG9ubHkpLlxuICAgICAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICApIDogbnVsbFxuICAgICAgICApIDogbnVsbH1cbiAgICAgIDwvQm94PlxuXG4gICAgICB7aXNTdGFuZGFsb25lQ29tbWFuZCAmJiAoXG4gICAgICAgIDxUZXh0IGRpbUNvbG9yIGl0YWxpYz5cbiAgICAgICAgICB7ZXhpdFN0YXRlLnBlbmRpbmcgPyAoXG4gICAgICAgICAgICA8PlByZXNzIHtleGl0U3RhdGUua2V5TmFtZX0gYWdhaW4gdG8gZXhpdDwvPlxuICAgICAgICAgICkgOiAoXG4gICAgICAgICAgICA8QnlsaW5lPlxuICAgICAgICAgICAgICA8S2V5Ym9hcmRTaG9ydGN1dEhpbnQgc2hvcnRjdXQ9XCJFbnRlclwiIGFjdGlvbj1cImNvbmZpcm1cIiAvPlxuICAgICAgICAgICAgICA8Q29uZmlndXJhYmxlU2hvcnRjdXRIaW50XG4gICAgICAgICAgICAgICAgYWN0aW9uPVwic2VsZWN0OmNhbmNlbFwiXG4gICAgICAgICAgICAgICAgY29udGV4dD1cIlNlbGVjdFwiXG4gICAgICAgICAgICAgICAgZmFsbGJhY2s9XCJFc2NcIlxuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uPVwiZXhpdFwiXG4gICAgICAgICAgICAgIC8+XG4gICAgICAgICAgICA8L0J5bGluZT5cbiAgICAgICAgICApfVxuICAgICAgICA8L1RleHQ+XG4gICAgICApfVxuICAgIDwvQm94PlxuICApXG5cbiAgaWYgKCFpc1N0YW5kYWxvbmVDb21tYW5kKSB7XG4gICAgcmV0dXJuIGNvbnRlbnRcbiAgfVxuXG4gIHJldHVybiA8UGFuZSBjb2xvcj1cInBlcm1pc3Npb25cIj57Y29udGVudH08L1BhbmU+XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVPcHRpb25Nb2RlbCh2YWx1ZT86IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGlmICghdmFsdWUpIHJldHVybiB1bmRlZmluZWRcbiAgcmV0dXJuIHZhbHVlID09PSBOT19QUkVGRVJFTkNFXG4gICAgPyBnZXREZWZhdWx0TWFpbkxvb3BNb2RlbCgpXG4gICAgOiBwYXJzZVVzZXJTcGVjaWZpZWRNb2RlbCh2YWx1ZSlcbn1cblxuZnVuY3Rpb24gRWZmb3J0TGV2ZWxJbmRpY2F0b3Ioe1xuICBlZmZvcnQsXG59OiB7XG4gIGVmZm9ydD86IEVmZm9ydExldmVsXG59KTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIChcbiAgICA8VGV4dCBjb2xvcj17ZWZmb3J0ID8gJ2NsYXVkZScgOiAnc3VidGxlJ30+XG4gICAgICB7ZWZmb3J0TGV2ZWxUb1N5bWJvbChlZmZvcnQgPz8gJ2xvdycpfVxuICAgIDwvVGV4dD5cbiAgKVxufVxuXG5mdW5jdGlvbiBjeWNsZUVmZm9ydExldmVsKFxuICBjdXJyZW50OiBFZmZvcnRMZXZlbCxcbiAgZGlyZWN0aW9uOiAnbGVmdCcgfCAncmlnaHQnLFxuICBpbmNsdWRlTWF4OiBib29sZWFuLFxuICBpbmNsdWRlWEhpZ2g6IGJvb2xlYW4sXG4pOiBFZmZvcnRMZXZlbCB7XG4gIGNvbnN0IGxldmVsczogRWZmb3J0TGV2ZWxbXSA9IFsnbG93JywgJ21lZGl1bScsICdoaWdoJ11cbiAgaWYgKGluY2x1ZGVYSGlnaCkgbGV2ZWxzLnB1c2goJ3hoaWdoJylcbiAgaWYgKGluY2x1ZGVNYXgpIGxldmVscy5wdXNoKCdtYXgnKVxuICAvLyBJZiB0aGUgY3VycmVudCBsZXZlbCBpc24ndCBpbiB0aGUgY3ljbGUgYWZ0ZXIgc3dpdGNoaW5nIG1vZGVscywgY2xhbXAgdG8gJ2hpZ2gnLlxuICBjb25zdCBpZHggPSBsZXZlbHMuaW5kZXhPZihjdXJyZW50KVxuICBjb25zdCBjdXJyZW50SW5kZXggPSBpZHggIT09IC0xID8gaWR4IDogbGV2ZWxzLmluZGV4T2YoJ2hpZ2gnKVxuICBpZiAoZGlyZWN0aW9uID09PSAncmlnaHQnKSB7XG4gICAgcmV0dXJuIGxldmVsc1soY3VycmVudEluZGV4ICsgMSkgJSBsZXZlbHMubGVuZ3RoXSFcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gbGV2ZWxzWyhjdXJyZW50SW5kZXggLSAxICsgbGV2ZWxzLmxlbmd0aCkgJSBsZXZlbHMubGVuZ3RoXSFcbiAgfVxufVxuXG5mdW5jdGlvbiBnZXREZWZhdWx0RWZmb3J0TGV2ZWxGb3JPcHRpb24odmFsdWU/OiBzdHJpbmcpOiBFZmZvcnRMZXZlbCB7XG4gIGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZU9wdGlvbk1vZGVsKHZhbHVlKSA/PyBnZXREZWZhdWx0TWFpbkxvb3BNb2RlbCgpXG4gIGNvbnN0IGRlZmF1bHRWYWx1ZSA9IGdldERlZmF1bHRFZmZvcnRGb3JNb2RlbChyZXNvbHZlZClcbiAgcmV0dXJuIGRlZmF1bHRWYWx1ZSAhPT0gdW5kZWZpbmVkXG4gICAgPyBjb252ZXJ0RWZmb3J0VmFsdWVUb0xldmVsKGRlZmF1bHRWYWx1ZSlcbiAgICA6ICdoaWdoJ1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBT0EsVUFBVSxNQUFNLHlCQUF5QjtBQUNoRCxPQUFPLEtBQUtDLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLFdBQVcsRUFBRUMsT0FBTyxFQUFFQyxRQUFRLFFBQVEsT0FBTztBQUN0RCxTQUFTQyw4QkFBOEIsUUFBUSw2Q0FBNkM7QUFDNUYsU0FDRSxLQUFLQywwREFBMEQsRUFDL0RDLFFBQVEsUUFDSCxpQ0FBaUM7QUFDeEMsU0FDRUMsdUJBQXVCLEVBQ3ZCQyxtQkFBbUIsRUFDbkJDLGtCQUFrQixFQUNsQkMsaUJBQWlCLFFBQ1osdUJBQXVCO0FBQzlCLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLFdBQVc7QUFDckMsU0FBU0MsY0FBYyxRQUFRLGlDQUFpQztBQUNoRSxTQUFTQyxXQUFXLEVBQUVDLGNBQWMsUUFBUSxzQkFBc0I7QUFDbEUsU0FDRUMseUJBQXlCLEVBQ3pCLEtBQUtDLFdBQVcsRUFDaEJDLHdCQUF3QixFQUN4QkMsbUJBQW1CLEVBQ25CQyxz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