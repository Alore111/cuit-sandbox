/* ================================================================
   视角预设的类型
   —— 放在 types 层：UI 只认名字与文案，机位几何留在渲染层（render/view/presets.ts）。
================================================================ */

export type ViewPresetName = 'overview' | 'top' | 'orbit' | 'ground';

export const VIEW_PRESET_NAMES: readonly ViewPresetName[] = [
    'overview',
    'top',
    'orbit',
    'ground'
];
