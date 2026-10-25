#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifndef AppId
  #define AppId "Shiye.Desktop"
#endif
#ifndef AppName
  #define AppName "拾页"
#endif
#ifndef OutputBaseName
  #define OutputBaseName "shiye-" + AppVersion + "-setup-x64"
#endif

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=ChuXuan
AppPublisherURL=https://github.com/V-ChuXuan/shiye
AppSupportURL=https://github.com/V-ChuXuan/shiye/issues
DefaultDirName={localappdata}\Programs\Shiye
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableDirPage=no
DisableProgramGroupPage=yes
AppendDefaultDirName=no
WizardStyle=modern
ShowLanguageDialog=no
CloseApplications=no
RestartApplications=no
UninstallDisplayIcon={app}\拾页.exe
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseName}
Compression=lzma2
SolidCompression=yes

[Languages]
Name: "zhcn"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\拾页.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\拾页.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\拾页.exe"; Description: "打开拾页"; Flags: nowait postinstall skipifsilent

[Code]
function RunningFromDirectory: Boolean;
var
  Locator, Services, Processes, Process: Variant;
  I: Integer;
  Root, FileName: String;
begin
  Result := False;
  Root := Lowercase(AddBackslash(ExpandConstant('{app}')));
  Locator := CreateOleObject('WbemScripting.SWbemLocator');
  Services := Locator.ConnectServer('.', 'root\CIMV2');
  Processes := Services.ExecQuery('SELECT ExecutablePath FROM Win32_Process WHERE Name = ''拾页.exe'' OR Name = ''node.exe''');
  for I := 0 to Processes.Count - 1 do begin
    Process := Processes.ItemIndex(I);
    if not VarIsNull(Process.ExecutablePath) then begin
      FileName := Lowercase(Process.ExecutablePath);
      if Copy(FileName, 1, Length(Root)) = Root then begin
        Result := True;
        Exit;
      end;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  try
    if RunningFromDirectory then
      Result := '请先从托盘退出此目录中的拾页，再继续安装。文库和图片会保留。';
  except
    Result := '无法检查程序是否已退出，请稍后重新运行安装程序。';
  end;
end;

function InitializeUninstall: Boolean;
var
  Message: String;
begin
  Message := '';
  try
    if RunningFromDirectory then
      Message := '请先从托盘退出此目录中的拾页，再卸载。文库和图片会保留。';
  except
    Message := '无法检查程序是否已退出，请稍后重新运行卸载程序。';
  end;
  Result := Message = '';
  if not Result then begin
    Log(Message);
    if not UninstallSilent then MsgBox(Message, mbInformation, MB_OK);
  end;
end;
