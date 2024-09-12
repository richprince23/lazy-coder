const vscode = require('vscode');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const fs = require('fs').promises;

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
            localResourceRoots: [this._context.extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // webviewView.webview.onDidReceiveMessage(async message => {
        //     if (message.command === 'sendPrompt') {
        //         try {
        //             await vscode.window.withProgress({
        //                 location: vscode.ProgressLocation.Notification,
        //                 title: "Generating response...",
        //                 cancellable: false
        //             }, async (progress) => {
        //                 const response = await this._processRequest(message.prompt, message.imagePath);
        //                 this._insertResponseInOutput(response);
        //                 vscode.window.showInformationMessage('Response generated!');
        //             });
        //         } catch (error) {
        //             vscode.window.showErrorMessage(`Error: ${error.message}`);
        //         }
        //     }
        // });

        webviewView.webview.onDidReceiveMessage(async message => {
            if (message.command === 'sendPrompt') {
                try {
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "Generating response...",
                        cancellable: false
                    }, async (progress) => {
                        const response = await this._processRequest(message.prompt, message.imagePath);
                        this._insertResponseInEditor(response);  // Changed from _insertResponseInOutput
                        vscode.window.showInformationMessage('Response inserted in editor!');
                    });
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
                    button { padding: 10px 20px; width:160px; min-width:100px; background-color: #0000f9; color: #fff; outline:none; border: 0; border-radius: 0.5rem;}
                </style>
            </head>
            <body>
               <h2>Lazy Coder</h2>
                <input type="file" id="imageUpload" accept="image/*" /><br/><br/>
                <textarea id="prompt" placeholder="Enter the name of the screen you want to generate"></textarea><br/>
                <button onclick="send()">Generate</button>

                <script>
                    const vscode = acquireVsCodeApi();

                    function send() {
                        const prompt = document.getElementById('prompt').value;
                        const imageUpload = document.getElementById('imageUpload').files[0];

                        if (imageUpload) {
                            const reader = new FileReader();
                            reader.onloadend = function () {
                                vscode.postMessage({
                                    command: 'sendPrompt',
                                    prompt: prompt,
                                    imagePath: reader.result
                                });
                            };
                            reader.readAsDataURL(imageUpload);
                        } else {
                            vscode.postMessage({
                                command: 'sendPrompt',
                                prompt: prompt,
                                imagePath: null
                            });
                        }
                    }
                </script>
            </body>
            </html>
        `;
    }

    async _processRequest(prompt, imageData) {
        const apiKey = await this._getApiKey();
        if (!genAI) {
            genAI = new GoogleGenerativeAI(apiKey);
            fileManager = new GoogleAIFileManager(apiKey);
        }

        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: "1.if there's an uploaded image,  Analyze the image and extract the following details:\n\nLayout: Describe the arrangement of elements (e.g., column, row, stack).\nColors: Specify the colors used for background, text, borders, etc.\nTypography: Note font family, size, weight, and style (e.g., bold, italic).\nSpacing: Measure padding, margin, and spacing between elements.\nShapes: Determine the shapes of elements (e.g., rectangular, rounded, circular).\nBorders: Specify border width, color, and style (e.g., solid, dashed).\n2. Generate Flutter code based on the extracted details.\n\nassuming the response is going to be written in a dart file, only output the code with no other text data.\nAlways assume that the main.dart has already been created so skip creating the MainApp, just the screen. output should be not be markdown, just the code only",
        });

        const generationConfig = {
            temperature: 1,
            topP: 0.95,
            topK: 64,
            maxOutputTokens: 8192,
        };

        const chatSession = model.startChat({ generationConfig });

        if (imageData) {
            const tempFilePath = await this._saveTempFile(imageData);
            const file = await this._uploadToGemini(tempFilePath, "image/jpeg");
            await fs.unlink(tempFilePath);

            await chatSession.sendMessage({
                role: "user",
                parts: [
                    {
                        fileData: {
                            mimeType: file.mimeType,
                            fileUri: file.uri,
                        },
                    },
                ],
            });
        }

        const result = await chatSession.sendMessage(prompt);
        return result.response.text();
    }

    async _saveTempFile(dataUrl) {
        const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
        const tempFilePath = `${vscode.workspace.rootPath}/temp_image_${Date.now()}.jpg`;
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

    // _insertResponseInOutput(response) {
    //     if (!this._outputChannel) {
    //         this._outputChannel = vscode.window.createOutputChannel("Lazy Coder");
    //     }
    //     this._outputChannel.clear();
    //     this._outputChannel.append(response);
    //     this._outputChannel.show();
    // }

    _insertResponseInEditor(response) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            editor.edit(editBuilder => {
                const position = editor.selection.active;
                editBuilder.insert(position, response);
            });
        } else {
            vscode.window.showWarningMessage('No active text editor found. Opening a new file.');
            vscode.workspace.openTextDocument({ content: response }).then(doc => {
                vscode.window.showTextDocument(doc);
            });
        }
    }

    async _getApiKey() {
        const config = vscode.workspace.getConfiguration('lazyCoder');
        let apiKey = config.get('apiKey');
        
        if (!apiKey) {
            apiKey = await vscode.window.showInputBox({
                prompt: 'Enter your Gemini API Key',
                password: true
            });
            
            if (apiKey) {
                await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
            } else {
                throw new Error('API Key is required');
            }
        }
        
        return apiKey;
    }
}

function activate(context) {
    const provider = new LazyCodingSidebar(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('lazyCodingSidebar', provider)
    );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};