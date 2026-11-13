import { detectHost } from "./host";
import { mount, showEditorError } from "./main";

void mount(detectHost()).catch(showEditorError);
