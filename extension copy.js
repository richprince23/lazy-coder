const vscode = require("vscode");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const fs = require("fs").promises;

let genAI, fileManager;

class LazyCodingSidebar {
  constructor(context) {
    this._view = undefined;
    this._context = context;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.command === "sendPrompt") {
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Generating response...",
              cancellable: false,
            },
            async (progress) => {
              const response = await this._processRequest(
                message.prompt,
                message.imagePath,
                message.framework
              );
              this._insertResponseInEditor(response);
              vscode.window.showInformationMessage(
                "Response inserted in editor!"
              );
            }
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Error: ${error.message}`);
        }
      }
    });
  }

  _getHtmlForWebview(webview) {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Lazy Coder</title>
            <style>
                body { font-family: var(--vscode-font-family); padding: 10px; }
                textarea { width: 100%; height: 100px; margin-bottom: 10px; }
                #genButton { padding: 10px 20px; width:160px; min-width:100px; background-color: #0000f9; color: #fff; outline:none; border: 0; border-radius: 0.5rem; margin-top: 10px; cursor: pointer;}
                select { width: 100%; padding: 5px; margin-bottom: 10px; }
                #imagePreview { display: none; position: relative; margin-top: 10px; }
                #imagePreview img { max-width: 300px; }
                #removeImage { position: absolute; top: 5px; right: 5px; background: red; color: white; border: none; border-radius: 50px; width: 30px; height: 30px; cursor: pointer; }
            </style>
        </head>
        <body>
            <h2>Lazy Coder</h2>
           <select id="framework">
                <option value="Create a Stateless or Stateful Widget for the screen ">Flutter</option>
                <option value="Create a functional component with hooks. Use CSS-in-JS for styling ">React</option>
                <option value="Create a functional component with hooks. Use StyleSheet for styling ">React Native</option>
                <option value="Create a View struct. Use SwiftUI's declarative syntax ">SwiftUI</option>
                <option value="Create separate HTML, CSS, and JS files. Use modern CSS and flexbox features ">HTML/CSS/JavaScript</option>
                <option value="Create an Activity or Fragment for Android. Use Android Jetpack components ">Kotlin</option>
                <option value="Create a Vue 3 component with Composition API. Use scoped styles ">Vue</option>
                <option value="Create an Angular component with TypeScript. Use Angular's template syntax ">Angular</option>
            </select>

            <textarea id="prompt" placeholder="Enter the name of the screen you want to generate"></textarea><br/>
            <div class="controls">
            <input type="file" id="imageUpload" accept="image/*" />
            <button id="genButton" onclick="send()">Generate</button>
            </div>
            <div id="imagePreview">
                <img id="preview" src="" alt="Preview" />
                <button id="removeImage">X</button>
            </div>
            <br/>

            <script>
                const vscode = acquireVsCodeApi();
                let imageData = null;

                document.getElementById('imageUpload').addEventListener('change', function(event) {
                    const file = event.target.files[0];
                    if (file) {
                        const reader = new FileReader();
                        reader.onload = function(e) {
                            imageData = e.target.result;
                            document.getElementById('preview').src = imageData;
                            document.getElementById('imagePreview').style.display = 'block';
                        }
                        reader.readAsDataURL(file);
                    }
                });

                document.getElementById('removeImage').addEventListener('click', function() {
                    imageData = null;
                    document.getElementById('imageUpload').value = '';
                    document.getElementById('imagePreview').style.display = 'none';
                });

                function send() {
                    const prompt = document.getElementById('prompt').value;
                    const framework = document.getElementById('framework').value;
                    vscode.postMessage({
                        command: 'sendPrompt',
                        prompt: prompt,
                        imagePath: imageData,
                        framework: framework
                    });
                }
            </script>
        </body>
        </html>
    `;
  }

  async _processRequest(prompt, imageData, framework) {
    const apiKey = await this._getApiKey();
    if (!genAI) {
      genAI = new GoogleGenerativeAI(apiKey);
      fileManager = new GoogleAIFileManager(apiKey);
    }

    const systemInstruction = `1. If there's an uploaded image, analyze the image and extract the following details:
        Layout: Describe the arrangement of elements (e.g., column, row, stack).
        Colors: Specify the colors used for background, text, borders, etc.
        Typography: Note font family, size, weight, and style (e.g., bold, italic).
        Spacing: Measure padding, margin, and spacing between elements.
        Shapes: Determine the shapes of elements (e.g., rectangular, rounded, circular).
        Borders: Specify border width, color, and style (e.g., solid, dashed).

        2. Generate code for the ${framework} framework based on the extracted details or the provided prompt.

        3. For the specified framework, follow these guidelines:
        - Follow this instruction for the framework: ${framework}
        - The output should be only the code, without any comments, markdown formatting, or explanations.
        - Ensure the code is complete and can be directly used in a project for the specified framework.
        - For web-based frameworks (React, Vue, Angular, HTML/CSS/JavaScript), include appropriate styling within the component or in a separate CSS file.
        - If no image is provided, base the code on the text prompt, creating a user interface that matches the description.

        4. Do not include any comments in the generated code.`;

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: systemInstruction,
    });

    const generationConfig = {
      temperature: 1,
      topP: 0.95,
      topK: 64,
      maxOutputTokens: 8192,
    };

    const chatSession = model.startChat({ generationConfig });

    let messageParts = [
      { text: `Create a ${framework} screen for: ${prompt}` },
    ];

    if (imageData) {
      const tempFilePath = await this._saveTempFile(imageData);
      const file = await this._uploadToGemini(tempFilePath, "image/jpeg");
      await fs.unlink(tempFilePath);

      messageParts.unshift({
        fileData: {
          mimeType: file.mimeType,
          fileUri: file.uri,
        },
      });
    }

    const result = await chatSession.sendMessage(messageParts);
    return result.response.text();
  }

  async _saveTempFile(dataUrl) {
    const buffer = Buffer.from(dataUrl.split(",")[1], "base64");
    const tempFilePath = `${
      vscode.workspace.rootPath
    }/temp_image_${Date.now()}.jpg`;
    await fs.writeFile(tempFilePath, buffer);
    return tempFilePath;
  }

  async _uploadToGemini(path, mimeType) {
    const uploadResult = await fileManager.uploadFile(path, {
      mimeType,
      displayName: path,
    });
    const file = uploadResult.file;
    console.log(`Uploaded file ${file.displayName} as: ${file.name}`);
    return file;
  }

  _insertResponseInEditor(response) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.edit((editBuilder) => {
        const position = editor.selection.active;
        editBuilder.insert(position, response);
      });
    } else {
      vscode.window.showWarningMessage(
        "No active text editor found. Opening a new file."
      );
      vscode.workspace.openTextDocument({ content: response }).then((doc) => {
        vscode.window.showTextDocument(doc);
      });
    }
  }

  async _getApiKey() {
    const config = vscode.workspace.getConfiguration("lazyCoder");
    let apiKey = config.get("apiKey");

    if (!apiKey) {
      apiKey = await vscode.window.showInputBox({
        prompt: "Enter your Gemini API Key",
        password: true,
      });

      if (apiKey) {
        await config.update(
          "apiKey",
          apiKey,
          vscode.ConfigurationTarget.Global
        );
      } else {
        throw new Error("API Key is required");
      }
    }

    return apiKey;
  }
}
function activate(context) {
  const provider = new LazyCodingSidebar(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("lazyCodingSidebar", provider)
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
