#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef PackageRoot
  #define PackageRoot GetEnv("DISKLENS_PACKAGE_ROOT")
#endif

[Setup]
AppId={{E6108BA0-60E9-4A7A-9ACD-03A86DCBD15F}
AppName=DiskLens
AppVersion={#AppVersion}
AppVerName=DiskLens {#AppVersion}
AppPublisher=DiskLens
DefaultDirName={localappdata}\Programs\DiskLens
DefaultGroupName=DiskLens
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\..\assets\disklens.ico
UninstallDisplayIcon={app}\assets\disklens.ico
OutputDir=Output
OutputBaseFilename=DiskLens-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
VersionInfoVersion={#AppVersion}.0
VersionInfoCompany=DiskLens
VersionInfoDescription=DiskLens local storage intelligence installer

[Tasks]
Name: "desktopicon"; Description: "Create a Desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: checkablealone

[Files]
Source: "{#PackageRoot}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\DiskLens\DiskLens"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\installers\windows\Start-DiskLens.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\disklens.ico"
Name: "{autoprograms}\DiskLens\Stop DiskLens"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\installers\windows\Stop-DiskLens.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\disklens.ico"
Name: "{autodesktop}\DiskLens"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\installers\windows\Start-DiskLens.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\disklens.ico"; Tasks: desktopicon

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\installers\windows\Start-DiskLens.vbs"""; Description: "Launch DiskLens"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; User data, indexes, preferences and AI credentials are intentionally preserved.
