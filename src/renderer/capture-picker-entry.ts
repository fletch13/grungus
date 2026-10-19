import { renderCapturePicker, type CapturePickerBridge } from "./capture-picker.ts";
const bridge = (window as unknown as { capturePicker: CapturePickerBridge }).capturePicker;
void renderCapturePicker(document.getElementById("capture-root")!, bridge);
