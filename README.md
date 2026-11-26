# nape-pro-custom-firmware
Custom firmware for the Keychron Nape Pro

## Disclaimer
I am not responsible for any damage caused by the usage of this firmware.

## Custom Firmware Usage

Please read [#full-backup-and-recovery](#full-backup-and-recovery) first, and make sure you are able to perform it in case things go wrong.

### Flashing the firmware
Go to [nape-pro.jerrymk.com](https://nape-pro.jerrymk.com/), go to device tab, and follow the instructions.

[Video walkthrough](https://s3.jerrymk.com/pub/Screen%20Recording%202026-11-26%20153737.mp4)

### Protected mode
The LED should flash amber (2Hz, 50% duty), and mouse input remains non-functional when the custom firmware is first flashed. 

For flashing via the web tool, it will guide you through the adopting process. 

With CLI, use the `nape.exe adopt stock-profile.npb` to take a backup of the existing user data (mostly Bluetooth and 2.4GHz receiver bonds and profiles). Then, it will initialize the device for the custom firmware, and exit out of protected mode.

### Download mode
In case a bug in the firmware crashes the program, you may hold down the Bluetooth pairing key, M1, and M2 keys before powering it on. The green LED will flash (2Hz, 25ms), and the device is ready for a firmware flash over USB. This only works on the custom firmware that is not fully bricked. If you can't get USB flashing to work, UART flashing via MPTool is the fallback.

The user data may be restored when you want to go back to stock firmware.

## Full backup and Recovery
### Backup
1. Unpeel the rubber feet on the outer corners to remove the 4 screws, then slightly pry open the clips on the middle indicated in yellow. It won't take too much force.
<img width="1770" height="1160" alt="image" src="https://github.com/user-attachments/assets/9da5bcdc-e248-4867-9d19-b8314b542436" />
2. Use a USB to UART adaptor (also known as USB to TTL, FTDI breakout), connect the TX of the adaptor to RX, RX to TX, GND to GND, and connected P0_3 to GND as well. Leave 3V3 unconnected. Connect the adaptor to the computer and power on the Nape Pro.
<img width="3745" height="1142" alt="PXL_20261125_073532540 MP~2" src="https://github.com/user-attachments/assets/9e63a2b1-73d7-4632-85bc-3b00b1c82b68" />
3. Download [MPTool](https://github.com/rtkconnectivity/rtl87x2g_sdk/blob/ef30d747dfc6c80d467b4d48b1dc44a274504eab/tools/BeeMPTool-v1.1.2.4.zip) from Realtek, and launch it.
4. Select IC Type: RTL8762G_VB and your preferred language, and Confirm
<img width="912" height="555" alt="image" src="https://github.com/user-attachments/assets/2af1175e-3f20-4b93-9e2a-ed6e0edf3c1a" />
5. Enter debug mode, press Detect, only leave the valid COM port checked, then Open. (if this fails, power cycle the Nape Pro to reset it. It seems that you cannot reopen it after doing anything in the MPTool until you power cycle the Nape Pro.)
<img width="2495" height="326" alt="image" src="https://github.com/user-attachments/assets/7f5aef4a-5e3d-4627-9c33-60107604dffc" />
6. Check Read, Addr: 0x`04000000` and Size: 0x`100000`, then click Read and wait for the progress bar shows OK. Verify an exactly 1MiB file "ReadbackFlash.bin".
<img width="2441" height="572" alt="image" src="https://github.com/user-attachments/assets/c4aee6d8-5f4f-45e5-8956-c07d0b8eed63" />
7. If you want to do it again to be safe, power cycle the Nape Pro before pressing Detect and Open again, or else it might fail. Rename or copy the file before reading again or else it will be overwritten.

### Restoring a backup
Select Browse, pick the file, verify the files in the list (select the entry and click Delete or Delete All if added by mistake) and their addresses, then click Download. 
<img width="2441" height="1782" alt="image" src="https://github.com/user-attachments/assets/f1ad1803-e6a2-4cb1-ba34-5657097a9b8a" />
Note that the file name must have the MD5 checksum, and have a proper wrapper. Use the `nape.exe prepare-bin ReadbackFlash.bin --type dump --address 0x04000000` command to generate a proper file for flashing.
If you do not have a backup, you might be able to use the flash image supplied in the repository to get back up running. What you will lose is the Bluetooth connection bonds, 2.4GHz receiver bond (which can be re-paired on the stock firmware by unplugging the receiver, hold down the pairing button and 04 for 3 seconds until flashes green, then plug in the receiver), and the profiles. There doesn't seem to be anything, such as serial numbers, that is unique to each device and irrecoverable, though taking your own backup is still highly recommended.
