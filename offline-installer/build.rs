fn main() {
    #[cfg(windows)]
    {
        let mut resource = winres::WindowsResource::new();
        resource
            .set_icon("../client/src-tauri/icons/icon.ico")
            .set("FileDescription", "Nightingale Offline Installer")
            .set("ProductName", "Nightingale")
            .set("LegalCopyright", "GPL-3.0-or-later");
        resource.compile().expect("compile Windows resources");
    }
}
